// The socket-mode long-poll loop itself: read the persisted cursor,
// `GET /api/v1/agent/updates?after=&timeout=&limit=`, verify each row's
// envelope, hand verified rows to a caller-supplied handler, then persist
// the server's returned cursor -- "rows with id <= after are never
// returned again" (the socket mode contract), so writing the cursor IS the
// ack. A row a handler throws on still advances the cursor: the contract
// gives no redelivery mechanism for a row this plugin already fetched, so
// retrying it forever isn't possible either way -- log and move on.
//
// Deliberately dumb about what a "message" or "card_interaction" event
// means; that's src/channel.ts's job (decrypt, map to the OpenClaw inbound
// shape via inbound-mapper.ts, dispatch). This module only owns: fetch,
// verify, parse JSON, advance cursor, loop with backoff.

import { ACTIVE_POLL_DELAY_MS, IDLE_POLL_DELAY_MS } from "salt-agent-sdk";
import type { CursorStore } from "./cursor-store.js";
import { verifySocketEnvelope, type SocketEnvelopeHeaders } from "./envelope.js";

export interface SocketUpdateRow {
  id: string | number;
  delivery_id?: string;
  event: string;
  headers: SocketEnvelopeHeaders;
  body: string;
  created_at: string;
}

export interface VerifiedUpdate {
  id: string;
  event: string;
  deliveryId?: string;
  /** Parsed JSON body -- shape depends on `event`, same shape a webhook
   *  POST body of that event would have carried. */
  body: unknown;
  rawBody: string;
  createdAt: string;
}

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

export interface SocketPollerDeps {
  /** `after` is `undefined` when this identity has no real local cursor
   *  yet (a fresh start, or a lost/never-written cursor file) -- round-4
   *  socket contract (LANES.md K2): omit the param entirely rather than
   *  sending `after=0`, so salt-api's own server-side ack
   *  (`users.agent_updates_acked_id`) applies instead of replaying up to
   *  7 days of retained outbox. */
  fetchUpdates(
    after: string | undefined,
    timeoutSeconds: number,
    limit: number,
  ): Promise<{ updates: SocketUpdateRow[]; cursor: string }>;
  /** This agent's own webhook signing secret (salt-agent-sdk's
   *  `client.getWebhookSecret`). Called once per poll cycle; cache/TTL is
   *  the caller's concern if it matters. */
  getSigningSecret(): Promise<string | undefined>;
  cursorStore: CursorStore;
  onUpdate(update: VerifiedUpdate): Promise<void>;
  logger?: Logger;
  toleranceSeconds?: number;
}

export interface PollOnceOptions {
  timeoutSeconds?: number;
  limit?: number;
}

export interface PollOnceResult {
  fetched: number;
  processed: number;
  skipped: Array<{ id: string; reason: string }>;
  cursor: string;
}

// Round-4 socket contract (LANES.md K2, revised 2026-09-18, H1): salt-api
// clamps `timeout` server-side to 0..2s -- a real long-poll parks a whole
// Puma thread, and production runs few enough of them that a handful of
// concurrently-polling agents would starve ordinary traffic. Sending a
// higher value isn't rejected, just wasted on the wire.
const DEFAULT_TIMEOUT_SECONDS = 2;
const DEFAULT_LIMIT = 50;

/** One fetch-verify-dispatch-advance cycle. Exposed standalone so tests
 *  (and a caller wanting manual control, e.g. a CLI `salt poll-once`
 *  command) don't need the retry/backoff loop below. */
export async function pollOnce(deps: SocketPollerDeps, options: PollOnceOptions = {}): Promise<PollOnceResult> {
  const persisted = await deps.cursorStore.read();
  // "0" (this store's own not-yet-written sentinel -- see cursor-store.ts)
  // and null/undefined both mean "no real cursor yet": omit `after`
  // entirely so salt-api's server-side ack applies (see SocketPollerDeps'
  // own doc comment above) rather than sending `after=0`.
  const after = persisted && persisted !== "0" ? persisted : undefined;
  const secret = await deps.getSigningSecret();
  const { updates, cursor } = await deps.fetchUpdates(
    after,
    options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    options.limit ?? DEFAULT_LIMIT,
  );

  const skipped: Array<{ id: string; reason: string }> = [];
  let processed = 0;

  for (const row of updates) {
    const id = String(row.id);
    const verification = verifySocketEnvelope(row.headers, row.body, secret, {
      toleranceSeconds: deps.toleranceSeconds,
    });
    if (!verification.ok) {
      deps.logger?.error(`[salt-socket] update ${id} rejected: ${verification.reason}`);
      skipped.push({ id, reason: verification.reason });
      continue;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(row.body);
    } catch {
      deps.logger?.error(`[salt-socket] update ${id} has an invalid JSON body; skipping`);
      skipped.push({ id, reason: "invalid JSON body" });
      continue;
    }

    try {
      await deps.onUpdate({
        id,
        event: row.event,
        deliveryId: row.delivery_id ?? verification.deliveryId,
        body: parsedBody,
        rawBody: row.body,
        createdAt: row.created_at,
      });
      processed += 1;
    } catch (err) {
      // The cursor still advances past this row below -- see module
      // comment: there is no redelivery for a row already fetched.
      deps.logger?.error(`[salt-socket] update ${id} handler failed: ${(err as Error).message}`);
      skipped.push({ id, reason: `handler failed: ${(err as Error).message}` });
    }
  }

  await deps.cursorStore.write(cursor);
  return { fetched: updates.length, processed, skipped, cursor };
}

export interface RunLoopOptions extends PollOnceOptions {
  /** Injectable sleep, for tests and for a caller that wants a custom
   *  scheduler instead of a bare setTimeout loop. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay after a poll cycle that found real activity (>=1 row) --
   *  poll again soon. Defaults to salt-agent-sdk's ACTIVE_POLL_DELAY_MS
   *  (1s), so a fleet mixing this plugin with native salt-agent-sdk hosts
   *  polls at one shared cadence. */
  activeDelayMs?: number;
  /** Ceiling an idle poll cycle (zero updates, no error) backs off toward,
   *  one `activeDelayMs` step at a time, snapping back to `activeDelayMs`
   *  the instant a cycle finds something again -- round-4 socket contract
   *  (LANES.md K2): salt-api's short-poll only ever blocks up to ~2s now
   *  (was a real 25s long-poll), so without this an idle agent would hit
   *  the endpoint that often forever. Defaults to salt-agent-sdk's
   *  IDLE_POLL_DELAY_MS (5s). */
  idleDelayMs?: number;
  /** Backoff after a fetch-level error (network, non-2xx, etc. -- NOT a
   *  single row's signature failure, which is already handled and never
   *  throws). Doubles up to `maxErrorBackoffMs` on consecutive failures. */
  errorBackoffMs?: number;
  maxErrorBackoffMs?: number;
}

export interface SocketPollerHandle {
  stop(): void;
  /** Resolves once the loop has actually exited (after the in-flight
   *  `pollOnce` call, if any, settles). */
  done: Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `pollOnce` repeatedly until `stop()` is called. Never throws out of
 * the loop itself -- a fetch-level error is logged and backed off, same as
 * any long-running poller should behave.
 */
export function createSocketPoller(deps: SocketPollerDeps, options: RunLoopOptions = {}): SocketPollerHandle {
  const sleep = options.sleep ?? defaultSleep;
  let stopped = false;
  let errorBackoffMs = options.errorBackoffMs ?? 1_000;
  const maxErrorBackoffMs = options.maxErrorBackoffMs ?? 30_000;
  const activeDelayMs = options.activeDelayMs ?? ACTIVE_POLL_DELAY_MS;
  const maxIdleDelayMs = options.idleDelayMs ?? IDLE_POLL_DELAY_MS;
  let currentDelayMs = activeDelayMs;

  const done = (async () => {
    while (!stopped) {
      try {
        const result = await pollOnce(deps, options);
        errorBackoffMs = options.errorBackoffMs ?? 1_000; // reset on a clean cycle
        // Adaptive pacing (round-4 socket contract, LANES.md K2): poll
        // again soon right after real activity; back off one step at a
        // time toward maxIdleDelayMs the longer nothing shows up, and
        // snap back to activeDelayMs the moment something does.
        currentDelayMs = result.fetched > 0 ? activeDelayMs : Math.min(currentDelayMs + activeDelayMs, maxIdleDelayMs);
        if (stopped) break;
        await sleep(currentDelayMs);
      } catch (err) {
        if (stopped) break; // an intentional stop mid-request surfaces here too -- not a real failure
        deps.logger?.error(`[salt-socket] poll cycle failed: ${(err as Error).message}; backing off ${errorBackoffMs}ms`);
        await sleep(errorBackoffMs);
        errorBackoffMs = Math.min(errorBackoffMs * 2, maxErrorBackoffMs);
        currentDelayMs = activeDelayMs; // resume at the active cadence once traffic is flowing again
      }
    }
  })();

  return {
    stop() {
      stopped = true;
    },
    done,
  };
}
