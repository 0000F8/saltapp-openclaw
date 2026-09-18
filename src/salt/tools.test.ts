import { describe, expect, it, vi } from "vitest";
import { createSaltPostCardTool, createSaltRequestPaymentTool } from "./tools.js";

const restOptions = { host: "https://saltapp.ai", apiKey: "key-1" };

describe("createSaltPostCardTool", () => {
  it("returns null when the turn is not on the salt channel", () => {
    const factory = createSaltPostCardTool({
      resolveCurrentChatId: () => "chat-1",
      postCard: vi.fn(),
      updateCard: vi.fn(),
      restOptions,
    });
    expect(factory({ messageChannel: "telegram" })).toBeNull();
  });

  it("returns null when there is no resolvable chat id", () => {
    const factory = createSaltPostCardTool({
      resolveCurrentChatId: () => undefined,
      postCard: vi.fn(),
      updateCard: vi.fn(),
      restOptions,
    });
    expect(factory({ messageChannel: "salt" })).toBeNull();
  });

  it("posts a new card via postCard when no update_card_id is given", async () => {
    const postCard = vi.fn().mockResolvedValue({ id: "card-1" });
    const updateCard = vi.fn();
    const factory = createSaltPostCardTool({
      resolveCurrentChatId: () => "chat-1",
      postCard,
      updateCard,
      restOptions,
    });
    const tool = factory({ messageChannel: "salt" });
    expect(tool).not.toBeNull();

    const blocks = [{ kind: "section", text: "pick one" }];
    const result = await tool!.execute("call-1", { blocks, text: "choices" });

    expect(postCard).toHaveBeenCalledWith("chat-1", blocks, "choices");
    expect(updateCard).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "card-1" });
  });

  it("updates an existing card when update_card_id is given", async () => {
    const postCard = vi.fn();
    const updateCard = vi.fn().mockResolvedValue({ id: "card-1", updated: true });
    const factory = createSaltPostCardTool({
      resolveCurrentChatId: () => "chat-1",
      postCard,
      updateCard,
      restOptions,
    });
    const tool = factory({ messageChannel: "salt" })!;

    const blocks = [{ kind: "section", text: "updated" }];
    await tool.execute("call-1", { blocks, update_card_id: "card-1" });

    expect(updateCard).toHaveBeenCalledWith("card-1", blocks);
    expect(postCard).not.toHaveBeenCalled();
  });
});

describe("createSaltRequestPaymentTool", () => {
  it("returns null off the salt channel", () => {
    const factory = createSaltRequestPaymentTool({
      resolveCurrentChatId: () => "chat-1",
      postCard: vi.fn(),
      updateCard: vi.fn(),
      restOptions,
    });
    expect(factory({ messageChannel: "discord" })).toBeNull();
  });

  it("creates a payment request scoped to the current chat via mock REST", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "tr-1" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const factory = createSaltRequestPaymentTool({
      resolveCurrentChatId: () => "chat-1",
      postCard: vi.fn(),
      updateCard: vi.fn(),
      restOptions: { ...restOptions, fetchImpl },
    });
    const tool = factory({ messageChannel: "salt" })!;

    const result = await tool.execute("call-1", {
      payer_id: "human-1",
      wallet_id: "wallet-1",
      amount: "5.00",
      message: "for coffee",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://saltapp.ai/api/v1/transfer_requests");
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "chat-1",
      wallet_id: "wallet-1",
      receiver_id: "human-1",
      amount: "5.00",
      message: "for coffee",
    });
    expect(result).toEqual({ id: "tr-1" });
  });
});
