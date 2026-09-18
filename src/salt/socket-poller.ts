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
  fetchUpdates(
    after: string,
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

const DEFAULT_TIMEOUT_SECONDS = 25;
const DEFAULT_LIMIT = 50;

/** One fetch-verify-dispatch-advance cycle. Exposed standalone so tests
 *  (and a caller wanting manual control, e.g. a CLI `salt poll-once`
 *  command) don't need the retry/backoff loop below. */
export async function pollOnce(deps: SocketPollerDeps, options: PollOnceOptions = {}): Promise<PollOnceResult> {
  const after = (await deps.cursorStore.read()) ?? "0";
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
  /** Delay between successful poll cycles when the server answered with
   *  zero updates and no error -- normally 0, since the long-poll itself
   *  already waited up to `timeoutSeconds`. */
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

  const done = (async () => {
    while (!stopped) {
      try {
        await pollOnce(deps, options);
        errorBackoffMs = options.errorBackoffMs ?? 1_000; // reset on a clean cycle
        if (options.idleDelayMs) await sleep(options.idleDelayMs);
      } catch (err) {
        deps.logger?.error(`[salt-socket] poll cycle failed: ${(err as Error).message}; backing off ${errorBackoffMs}ms`);
        await sleep(errorBackoffMs);
        errorBackoffMs = Math.min(errorBackoffMs * 2, maxErrorBackoffMs);
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
