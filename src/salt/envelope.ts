// Verifies a socket-mode update envelope's signature.
//
// The socket mode contract (design-fleet/runs/2026-09-17-distribution/LANES.md,
// "Socket mode contract") says: "SDK clients verify each envelope with the
// same HMAC check they apply to webhooks, using `headers` + `body`, so a
// relay can't forge updates." That HMAC recipe lives inside
// salt-agent-sdk's `createWebhookServer` (webhook.ts's `rejectionReason`)
// and isn't exported as a standalone function, so this module reimplements
// the exact same recipe against the `{headers, body}` pair a long-poll
// update row carries instead of a live HTTP request:
//
//   X-Salt-Agent-Id: <agent id the update is addressed to>
//   X-Salt-Signature: t=<unix seconds>,v1=<hex hmac>
//   v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
//
// `rawBody` MUST be the exact JSON text salt-api stored for this update --
// re-serializing a parsed object would hash different bytes (key order,
// whitespace, number formatting) and never match.

import { createHmac, timingSafeEqual } from "node:crypto";

export type SocketEnvelopeHeaders = Record<string, string | undefined>;

export interface VerifyEnvelopeOptions {
  /** Reject signatures older (or newer -- clock skew) than this. Matches
   *  salt-agent-sdk's default of 300s. */
  toleranceSeconds?: number;
  /** Injectable clock, in epoch seconds, for deterministic tests. */
  nowSeconds?: () => number;
}

export type EnvelopeVerification =
  | { ok: true; agentId: string; deliveryId?: string }
  | { ok: false; reason: string };

const DEFAULT_TOLERANCE_SECONDS = 300;

/** Case-insensitive header lookup: the update row's `headers` object is
 *  whatever JSON salt-api stored, and JSON key casing is not guaranteed to
 *  survive every hop the same way an HTTP header name would. */
function getHeader(headers: SocketEnvelopeHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/**
 * Verify one socket-mode update row's envelope. Returns `{ok: true,
 * agentId}` when the signature checks out, or `{ok: false, reason}` --
 * never throws, so a poller can log-and-skip a bad row without taking the
 * whole loop down.
 */
export function verifySocketEnvelope(
  headers: SocketEnvelopeHeaders,
  rawBody: string,
  secret: string | undefined,
  options: VerifyEnvelopeOptions = {},
): EnvelopeVerification {
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const agentId = getHeader(headers, "X-Salt-Agent-Id");
  const signature = getHeader(headers, "X-Salt-Signature");
  const deliveryId = getHeader(headers, "X-Salt-Delivery-Id");
  if (!agentId || !signature) return { ok: false, reason: "missing signature" };

  const t = /t=(\d+)/.exec(signature)?.[1];
  const v1 = /v1=([0-9a-f]+)/.exec(signature)?.[1];
  if (!t || !v1) return { ok: false, reason: "malformed signature" };

  const age = Math.abs(nowSeconds() - Number(t));
  if (age > toleranceSeconds) return { ok: false, reason: `stale signature (${age}s old)` };

  if (!secret) return { ok: false, reason: "no signing key for agent" };

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(v1, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };

  return { ok: true, agentId, deliveryId };
}
