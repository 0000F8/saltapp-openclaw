import { describe, expect, it } from "vitest";
import { classifyChat, mapMessageEventToInbound } from "./inbound-mapper.js";

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

describe("mapMessageEventToInbound", () => {
  const baseMessage = {
    chat_id: "chat-1",
    message_id: "msg-1",
    message: "-----BEGIN PGP MESSAGE----- ... -----END PGP MESSAGE-----",
    user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
    mentions: [],
  };

  it("maps a DM message with sender and empty mentions", async () => {
    const result = await mapMessageEventToInbound(
      { message: baseMessage, chat: { users: [{ id: SELF_AGENT_ID }, { id: "human-1" }] } },
      { selfAgentId: SELF_AGENT_ID, decryptedText: "hey there" },
    );
    expect(result).toEqual({
      chatId: "chat-1",
      roomId: "chat-1",
      kind: "dm",
      sender: { id: "human-1", handle: "dan", displayName: "Dan", isAgent: false },
      text: "hey there",
      mentionsSelf: false,
      mentionedIds: [],
      isLane: false,
      laneKind: undefined,
      attachment: undefined,
      raw: { chatMeta: { users: [{ id: SELF_AGENT_ID }, { id: "human-1" }] }, message: baseMessage },
    });
  });

  it("sets mentionsSelf when this agent's id is in message.mentions", async () => {
    const message = { ...baseMessage, mentions: ["someone-else", SELF_AGENT_ID] };
    const result = await mapMessageEventToInbound(
      {
        message,
        chat: {
          users: [{ id: SELF_AGENT_ID }, { id: "human-1" }, { id: "human-2" }],
        },
      },
      { selfAgentId: SELF_AGENT_ID, decryptedText: "@salt_bot help" },
    );
    expect(result?.kind).toBe("group");
    expect(result?.mentionsSelf).toBe(true);
    expect(result?.mentionedIds).toEqual(["someone-else", SELF_AGENT_ID]);
  });

  it("mentionsSelf is case-insensitive", async () => {
    const message = { ...baseMessage, mentions: ["AGENT-SELF"] };
    const result = await mapMessageEventToInbound(
      { message, chat: { users: [{ id: SELF_AGENT_ID }, { id: "human-1" }] } },
      { selfAgentId: SELF_AGENT_ID, decryptedText: "hi" },
    );
    expect(result?.mentionsSelf).toBe(true);
  });

  it("marks a lane message with roomId pointing back at the shared chat", async () => {
    const message = { ...baseMessage, chat_id: "lane-1" };
    const result = await mapMessageEventToInbound(
      {
        message,
        chat: {
          coaching_for_chat_id: "chat-1",
          lane_kind: "consult",
          users: [{ id: SELF_AGENT_ID }, { id: "other-agent" }],
        },
      },
      { selfAgentId: SELF_AGENT_ID, decryptedText: "consult question" },
    );
    expect(result?.chatId).toBe("lane-1");
    expect(result?.roomId).toBe("chat-1");
    expect(result?.isLane).toBe(true);
    expect(result?.laneKind).toBe("consult");
  });

  it("returns null for a system event", async () => {
    const message = { ...baseMessage, event_type: "call_missed" };
    const result = await mapMessageEventToInbound(
      { message, chat: undefined },
      { selfAgentId: SELF_AGENT_ID, decryptedText: "" },
    );
    expect(result).toBeNull();
  });

  it("returns null when the row has no sender", async () => {
    const message = { ...baseMessage, user: undefined };
    const result = await mapMessageEventToInbound(
      { message, chat: undefined },
      { selfAgentId: SELF_AGENT_ID, decryptedText: "hi" },
    );
    expect(result).toBeNull();
  });

  it("carries an attachment through when provided", async () => {
    const message = { ...baseMessage, resource_type: "Attachment" };
    const result = await mapMessageEventToInbound(
      { message, chat: { users: [{ id: SELF_AGENT_ID }, { id: "human-1" }] } },
      {
        selfAgentId: SELF_AGENT_ID,
        decryptedText: "",
        attachment: { filename: "photo.jpg", contentType: "image/jpeg", size: 1024 },
      },
    );
    expect(result?.attachment).toEqual({ filename: "photo.jpg", contentType: "image/jpeg", size: 1024 });
  });

  it("marks isAgent true for an agent sender", async () => {
    const message = { ...baseMessage, user: { id: "other-agent", account_type: "Agent" } };
    const result = await mapMessageEventToInbound(
      { message, chat: { users: [{ id: SELF_AGENT_ID }, { id: "other-agent" }] } },
      { selfAgentId: SELF_AGENT_ID, decryptedText: "hello from another agent" },
    );
    expect(result?.sender.isAgent).toBe(true);
  });
});
