import { describe, expect, it, vi } from "vitest";
import { encryptForMembers, sendEncryptedReply, signalTypingSafely } from "./outbound.js";

const SELF_ID = "agent-self";
const SELF_PUBLIC_KEY = "armored-pub-self";

describe("encryptForMembers", () => {
  it("encrypts once for all non-self members with a known key, and once for self", async () => {
    const encryptFor = vi.fn(async (_plaintext: string, keys: string[]) => `cipher(${keys.join(",")})`);
    const members = [
      { id: SELF_ID, publicKey: SELF_PUBLIC_KEY },
      { id: "human-1", publicKey: "pub-human-1" },
      { id: "human-2", publicKey: "pub-human-2" },
    ];

    const result = await encryptForMembers({ encryptFor }, "hello everyone", members, SELF_ID, SELF_PUBLIC_KEY);

    expect(encryptFor).toHaveBeenCalledTimes(2);
    expect(encryptFor).toHaveBeenCalledWith("hello everyone", ["pub-human-1", "pub-human-2"]);
    expect(encryptFor).toHaveBeenCalledWith("hello everyone", [SELF_PUBLIC_KEY]);
    expect(result.message).toBe("cipher(pub-human-1,pub-human-2)");
    expect(result.senderMessage).toBe(`cipher(${SELF_PUBLIC_KEY})`);
    expect(result.skippedMemberIds).toEqual([]);
  });

  it("excludes the agent's own id from the recipient-key encryption call", async () => {
    const encryptFor = vi.fn(async () => "cipher");
    const members = [{ id: SELF_ID, publicKey: SELF_PUBLIC_KEY }, { id: "human-1", publicKey: "pub-human-1" }];
    await encryptForMembers({ encryptFor }, "hi", members, SELF_ID, SELF_PUBLIC_KEY);
    const [recipientCall] = encryptFor.mock.calls;
    expect(recipientCall[1]).not.toContain(SELF_PUBLIC_KEY);
  });

  it("is case-insensitive when matching the self id", async () => {
    const encryptFor = vi.fn(async () => "cipher");
    const members = [{ id: "AGENT-SELF", publicKey: SELF_PUBLIC_KEY }, { id: "human-1", publicKey: "pub-human-1" }];
    const result = await encryptForMembers({ encryptFor }, "hi", members, SELF_ID, SELF_PUBLIC_KEY);
    expect(result.skippedMemberIds).toEqual([]);
    expect(encryptFor).toHaveBeenCalledWith("hi", ["pub-human-1"]);
  });

  it("reports members with no known public key as skipped instead of silently dropping them", async () => {
    const encryptFor = vi.fn(async () => "cipher");
    const members = [
      { id: SELF_ID, publicKey: SELF_PUBLIC_KEY },
      { id: "human-1", publicKey: "pub-human-1" },
      { id: "human-2" }, // no key -- e.g. a legacy pre-vault row
    ];
    const result = await encryptForMembers({ encryptFor }, "hi", members, SELF_ID, SELF_PUBLIC_KEY);
    expect(result.skippedMemberIds).toEqual(["human-2"]);
    expect(encryptFor).toHaveBeenCalledWith("hi", ["pub-human-1"]);
  });

  it("refuses to send when no recipient has a known key at all", async () => {
    const encryptFor = vi.fn(async () => "cipher");
    const members = [{ id: SELF_ID, publicKey: SELF_PUBLIC_KEY }, { id: "human-1" }];
    await expect(encryptForMembers({ encryptFor }, "hi", members, SELF_ID, SELF_PUBLIC_KEY)).rejects.toThrow(
      /no recipient with a known public key/,
    );
  });

  it("handles a 1:1 (single other member) correctly", async () => {
    const encryptFor = vi.fn(async (_plaintext: string, keys: string[]) => `cipher(${keys.join(",")})`);
    const members = [{ id: SELF_ID, publicKey: SELF_PUBLIC_KEY }, { id: "human-1", publicKey: "pub-human-1" }];
    const result = await encryptForMembers({ encryptFor }, "hi", members, SELF_ID, SELF_PUBLIC_KEY);
    expect(result.message).toBe("cipher(pub-human-1)");
  });
});

describe("sendEncryptedReply", () => {
  it("fetches members, encrypts for all of them, and posts via the injected client (mock REST)", async () => {
    const encryptFor = vi.fn(async (_plaintext: string, keys: string[]) => `cipher(${keys.join(",")})`);
    const getChatMembers = vi.fn(async (chatId: string) => {
      expect(chatId).toBe("chat-1");
      return [
        { id: SELF_ID, publicKey: SELF_PUBLIC_KEY },
        { id: "human-1", publicKey: "pub-human-1" },
        { id: "human-2", publicKey: "pub-human-2" },
      ];
    });
    const postMessage = vi.fn(async () => ({ id: "msg-99" }));

    const result = await sendEncryptedReply(
      { encryptFor, getChatMembers, postMessage },
      { chatId: "chat-1", text: "hi all", selfAgentId: SELF_ID, selfPublicKey: SELF_PUBLIC_KEY, mentions: ["human-1"] },
    );

    expect(getChatMembers).toHaveBeenCalledWith("chat-1");
    expect(postMessage).toHaveBeenCalledWith(
      "chat-1",
      "cipher(pub-human-1,pub-human-2)",
      `cipher(${SELF_PUBLIC_KEY})`,
      ["human-1"],
    );
    expect(result).toEqual({ id: "msg-99" });
  });

  it("logs but still sends when a member has no known key", async () => {
    const encryptFor = vi.fn(async () => "cipher");
    const getChatMembers = vi.fn(async () => [
      { id: SELF_ID, publicKey: SELF_PUBLIC_KEY },
      { id: "human-1", publicKey: "pub-human-1" },
      { id: "human-2" },
    ]);
    const postMessage = vi.fn(async () => ({ id: "msg-1" }));
    const logger = { info: vi.fn(), error: vi.fn() };

    await sendEncryptedReply(
      { encryptFor, getChatMembers, postMessage, logger },
      { chatId: "chat-1", text: "hi", selfAgentId: SELF_ID, selfPublicKey: SELF_PUBLIC_KEY },
    );

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("human-2"));
    expect(postMessage).toHaveBeenCalled();
  });
});

describe("signalTypingSafely", () => {
  it("does nothing when no signalTyping function is provided", async () => {
    await expect(signalTypingSafely(undefined, "chat-1")).resolves.toBeUndefined();
  });

  it("calls signalTyping and swallows a rejection", async () => {
    const signalTyping = vi.fn().mockRejectedValue(new Error("boom"));
    const logger = { error: vi.fn() };
    await expect(signalTypingSafely(signalTyping, "chat-1", logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("calls signalTyping successfully with no error", async () => {
    const signalTyping = vi.fn().mockResolvedValue(undefined);
    await signalTypingSafely(signalTyping, "chat-1");
    expect(signalTyping).toHaveBeenCalledWith("chat-1");
  });
});
