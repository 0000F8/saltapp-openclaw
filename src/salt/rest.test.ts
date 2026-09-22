import { describe, expect, it, vi } from "vitest";
import {
  addReaction,
  createPaymentRequest,
  getChat,
  getPublicConfig,
  isOpenRoom,
  joinPublicChat,
  SaltRestError,
} from "./rest.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

describe("getChat", () => {
  it("GETs /api/v1/chats/:id with the api-key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "chat-1", encrypted: false }));
    const result = await getChat({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "chat-1");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://saltapp.ai/api/v1/chats/chat-1");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key-1");
    expect(result).toEqual({ id: "chat-1", encrypted: false });
  });
});

describe("isOpenRoom", () => {
  it("is true when the chat's encrypted flag is exactly false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "chat-1", encrypted: false }));
    expect(await isOpenRoom({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "chat-1")).toBe(true);
  });

  it("is false when encrypted is absent (ordinary E2E chat)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "chat-1" }));
    expect(await isOpenRoom({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "chat-1")).toBe(false);
  });

  it("fails closed (false) when the lookup itself fails, and logs why", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const logger = { error: vi.fn() };
    const result = await isOpenRoom({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "chat-1", logger);
    expect(result).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("chat-1"));
  });
});

describe("getPublicConfig", () => {
  it("GETs /api/v1/config with no auth header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ commons_chat_id: "commons-1" }));
    const result = await getPublicConfig({ host: "https://saltapp.ai", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("https://saltapp.ai/api/v1/config");
    expect(init?.headers).toBeUndefined();
    expect(result.commons_chat_id).toBe("commons-1");
  });
});

describe("joinPublicChat", () => {
  it("POSTs /api/v1/chats/:id/join_public with the api-key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await joinPublicChat({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "commons-1");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://saltapp.ai/api/v1/chats/commons-1/join_public");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key-1");
  });
});

describe("error handling", () => {
  it("throws SaltRestError with method/url/status/body on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));
    await expect(
      joinPublicChat({ host: "https://saltapp.ai", apiKey: "key-1", fetchImpl }, "commons-1"),
    ).rejects.toMatchObject({
      name: "SaltRestError",
      method: "POST",
      status: 404,
      body: "Not found",
    } satisfies Partial<SaltRestError>);
  });
});
