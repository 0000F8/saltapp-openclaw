import { describe, expect, it, vi } from "vitest";
import {
  addReaction,
  createPaymentRequest,
  fetchAgentUpdates,
  SaltRestError,
  setDeliveryMode,
} from "./rest.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("setDeliveryMode", () => {
  it("PATCHes /api/v1/agents/delivery with the requested mode and api-key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await setDeliveryMode({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "socket");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://saltapp.ai/api/v1/agents/delivery");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key-1");
    expect(JSON.parse(init.body as string)).toEqual({ mode: "socket" });
  });
});

describe("fetchAgentUpdates", () => {
  it("builds the query string and returns updates + cursor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        updates: [{ id: 5, event: "message", headers: {}, body: "{}", created_at: "2026-09-18T00:00:00Z" }],
        cursor: "5",
      }),
    );
    const result = await fetchAgentUpdates(
      { host: "https://saltapp.ai", apiKey: "key-1", fetchImpl },
      { after: "0", timeoutSeconds: 25, limit: 50 },
    );

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("https://saltapp.ai/api/v1/agent/updates?after=0&timeout=25&limit=50");
    expect(result.cursor).toBe("5");
    expect(result.updates).toHaveLength(1);
  });

  it("omits `after` entirely when not provided -- round-4 contract: a fresh/lost cursor lets salt-api's own server-side ack apply", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ updates: [], cursor: "0" }));
    await fetchAgentUpdates({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, { timeoutSeconds: 2, limit: 50 });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("https://saltapp.ai/api/v1/agent/updates?timeout=2&limit=50");
    expect(url).not.toContain("after=");
  });

  it("strips a trailing slash from host before building the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ updates: [], cursor: "0" }));
    await fetchAgentUpdates(
      { host: "https://saltapp.ai/", apiKey: "key-1", fetchImpl },
      { after: "0" },
    );
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url.startsWith("https://saltapp.ai/api/v1/agent/updates")).toBe(true);
  });
});

describe("createPaymentRequest", () => {
  it("posts the plain-request shape to /api/v1/transfer_requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "tr-1" }));
    await createPaymentRequest(
      { host: "https://saltapp.ai", apiKey: "key-1", fetchImpl },
      { chatId: "chat-1", walletId: "wallet-1", payerId: "human-1", amount: "12.50", message: "for the thing" },
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://saltapp.ai/api/v1/transfer_requests");
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "chat-1",
      wallet_id: "wallet-1",
      receiver_id: "human-1",
      amount: "12.50",
      message: "for the thing",
    });
  });
});

describe("addReaction", () => {
  it("posts to /api/v1/messages/:id/reactions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await addReaction({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "msg-1", "👍");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://saltapp.ai/api/v1/messages/msg-1/reactions");
    expect(JSON.parse(init.body as string)).toEqual({ emoji: "👍" });
  });
});

describe("error handling", () => {
  it("throws SaltRestError with method/url/status/body on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("Not found", { status: 404 }),
    );
    await expect(
      setDeliveryMode({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "socket"),
    ).rejects.toMatchObject({
      name: "SaltRestError",
      method: "PATCH",
      status: 404,
      body: "Not found",
    } satisfies Partial<SaltRestError>);
  });
});
