import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySocketEnvelope } from "./envelope.js";

const SECRET = "whsec_test_secret";

function sign(rawBody: string, t: number, secret: string = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifySocketEnvelope", () => {
  const body = JSON.stringify({ message: { chat_id: "1", message: "-----BEGIN PGP MESSAGE-----" } });

  it("accepts a correctly signed, fresh envelope", () => {
    const now = 1_700_000_000;
    const headers = {
      "X-Salt-Agent-Id": "agent-123",
      "X-Salt-Signature": sign(body, now),
      "X-Salt-Delivery-Id": "delivery-1",
    };
    const result = verifySocketEnvelope(headers, body, SECRET, { nowSeconds: () => now });
    expect(result).toEqual({ ok: true, agentId: "agent-123", deliveryId: "delivery-1" });
  });

  it("is case-insensitive on header names", () => {
    const now = 1_700_000_000;
    const headers = {
      "x-salt-agent-id": "agent-123",
      "x-salt-signature": sign(body, now),
    };
    const result = verifySocketEnvelope(headers, body, SECRET, { nowSeconds: () => now });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing signature header", () => {
    const result = verifySocketEnvelope({ "X-Salt-Agent-Id": "agent-123" }, body, SECRET);
    expect(result).toEqual({ ok: false, reason: "missing signature" });
  });

  it("rejects a missing agent id header", () => {
    const now = 1_700_000_000;
    const result = verifySocketEnvelope(
      { "X-Salt-Signature": sign(body, now) },
      body,
      SECRET,
      { nowSeconds: () => now },
    );
    expect(result).toEqual({ ok: false, reason: "missing signature" });
  });

  it("rejects a malformed signature value", () => {
    const result = verifySocketEnvelope(
      { "X-Salt-Agent-Id": "agent-123", "X-Salt-Signature": "not-a-real-signature" },
      body,
      SECRET,
    );
    expect(result).toEqual({ ok: false, reason: "malformed signature" });
  });

  it("rejects a stale signature outside the tolerance window", () => {
    const signedAt = 1_700_000_000;
    const headers = {
      "X-Salt-Agent-Id": "agent-123",
      "X-Salt-Signature": sign(body, signedAt),
    };
    const result = verifySocketEnvelope(headers, body, SECRET, {
      nowSeconds: () => signedAt + 400,
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ ok: false, reason: "stale signature (400s old)" });
  });

  it("rejects when no signing secret is available", () => {
    const now = 1_700_000_000;
    const headers = {
      "X-Salt-Agent-Id": "agent-123",
      "X-Salt-Signature": sign(body, now),
    };
    const result = verifySocketEnvelope(headers, body, undefined, { nowSeconds: () => now });
    expect(result).toEqual({ ok: false, reason: "no signing key for agent" });
  });

  it("rejects a bad digest (forged/tampered body or wrong secret)", () => {
    const now = 1_700_000_000;
    const headers = {
      "X-Salt-Agent-Id": "agent-123",
      "X-Salt-Signature": sign(body, now, "a-different-secret"),
    };
    const result = verifySocketEnvelope(headers, body, SECRET, { nowSeconds: () => now });
    expect(result).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects when the body was tampered with after signing", () => {
    const now = 1_700_000_000;
    const headers = {
      "X-Salt-Agent-Id": "agent-123",
      "X-Salt-Signature": sign(body, now),
    };
    const tamperedBody = body.replace("1", "2");
    const result = verifySocketEnvelope(headers, tamperedBody, SECRET, { nowSeconds: () => now });
    expect(result).toEqual({ ok: false, reason: "bad signature" });
  });
});
