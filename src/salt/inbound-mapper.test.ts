import { describe, expect, it } from "vitest";
import { classifyChat, mentionsSelfByHandle } from "./inbound-mapper.js";

const SELF_AGENT_ID = "agent-self";

describe("classifyChat", () => {
  it("classifies a 1:1 from inline members (2 non-observer members)", async () => {
    const kind = await classifyChat(
      "chat-1",
      { users: [{ id: SELF_AGENT_ID }, { id: "human-1" }] },
      { selfAgentId: SELF_AGENT_ID },
    );
    expect(kind).toBe("dm");
  });

  it("classifies a group from inline members (3+ non-observer members)", async () => {
    const kind = await classifyChat(
      "chat-1",
      { users: [{ id: SELF_AGENT_ID }, { id: "human-1" }, { id: "human-2" }] },
      { selfAgentId: SELF_AGENT_ID },
    );
    expect(kind).toBe("group");
  });

  it("ignores observer members when counting (delegation-observability 1:1s stay DMs)", async () => {
    const kind = await classifyChat(
      "chat-1",
      {
        users: [
          { id: SELF_AGENT_ID },
          { id: "other-agent" },
          { id: "silent-owner", observer: true },
        ],
      },
      { selfAgentId: SELF_AGENT_ID },
    );
    expect(kind).toBe("dm");
  });

  it("falls back to fetchMembers when chatMeta carries no inline users", async () => {
    const fetchMembers = async (chatId: string) => {
      expect(chatId).toBe("chat-2");
      return [{ id: SELF_AGENT_ID }, { id: "human-1" }, { id: "human-2" }];
    };
    const kind = await classifyChat("chat-2", undefined, { selfAgentId: SELF_AGENT_ID, fetchMembers });
    expect(kind).toBe("group");
  });

  it("falls back to the name/public heuristic when no member data is available at all", async () => {
    const dm = await classifyChat("chat-3", {}, { selfAgentId: SELF_AGENT_ID });
    const group = await classifyChat("chat-4", { name: "Ops room" }, { selfAgentId: SELF_AGENT_ID });
    expect(dm).toBe("dm");
    expect(group).toBe("group");
  });
});

describe("mentionsSelfByHandle", () => {
  it("is false with no configured handle, even if the text mentions someone", () => {
    expect(mentionsSelfByHandle("hey @salt_bot can you help?", undefined)).toBe(false);
  });

  it("matches a plain @handle mention", () => {
    expect(mentionsSelfByHandle("hey @salt_bot can you help?", "salt_bot")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(mentionsSelfByHandle("hey @SALT_BOT can you help?", "salt_bot")).toBe(true);
  });

  it("matches at the start of the message", () => {
    expect(mentionsSelfByHandle("@salt_bot are you there?", "salt_bot")).toBe(true);
  });

  it("does not match a longer handle that merely contains this one as a substring", () => {
    expect(mentionsSelfByHandle("ask @salt_bot_two instead", "salt_bot")).toBe(false);
  });

  it("does not match when the handle appears with no @ at all", () => {
    expect(mentionsSelfByHandle("salt_bot, are you there?", "salt_bot")).toBe(false);
  });

  it("does not match an unrelated message", () => {
    expect(mentionsSelfByHandle("what time is the meeting?", "salt_bot")).toBe(false);
  });

  it("escapes regex-special characters in the configured handle", () => {
    expect(mentionsSelfByHandle("hey @salt.bot+1 there", "salt.bot+1")).toBe(true);
  });
});
