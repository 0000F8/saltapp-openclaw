// Maps a decrypted Salt `message` webhook/update body into a small,
// well-defined intermediate shape (`SaltInboundMessage`) that channel.ts's
// best-effort OpenClaw dispatch call is built from. Kept separate from
// envelope verification and decryption so it can be unit tested with plain
// objects -- no crypto, no network.
//
// Field provenance (salt-agent-sdk's webhook.ts `handleMessage`, and
// CLAUDE.md's "Agents" section):
//   body.message.chat_id       -- SaltId
//   body.message.message_id    -- SaltId, for dedup (left to the caller)
//   body.message.message       -- PGP ciphertext (decrypted by the caller
//                                  before this module ever sees the text)
//   body.message.user          -- RawSender {id, account_type, ...}
//   body.message.mentions      -- SaltId[] (jsonb), only ids the client
//                                  resolved from an @handle -- Salt never
//                                  sees plaintext, so this is the ONLY
//                                  reliable mention signal
//   body.message.event_type    -- present => a system event, not a prompt
//   body.message.resource_type -- "Attachment" => decrypted separately
//   body.chat                  -- RawChatMeta; the ordinary message webhook
//                                  body does NOT inline `users` in
//                                  production (WebhookJob#user_send's
//                                  allowlist) -- only chat_opened does.

export type SaltChatKind = "dm" | "group";

export interface RawChatMetaLike {
  name?: string;
  public?: boolean;
  open_invite?: boolean;
  managed?: boolean;
  active_agent_id?: string;
  mediator_agent_id?: string;
  coaching_for_chat_id?: string;
  private_lane?: boolean;
  lane_kind?: string;
  users?: Array<{ id: string; account_type?: string; observer?: boolean }>;
  [key: string]: unknown;
}

export interface RawSenderLike {
  id: string;
  username?: string;
  display_name?: string;
  account_type?: "User" | "Agent";
  [key: string]: unknown;
}

export interface SaltInboundSender {
  id: string;
  handle?: string;
  displayName?: string;
  isAgent: boolean;
}

export interface SaltInboundAttachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface SaltInboundMessage {
  chatId: string;
  /** The shared chat this message's conversation ultimately serves: chatId
   *  itself, or chatMeta.coaching_for_chat_id when chatId is a lane. */
  roomId: string;
  kind: SaltChatKind;
  sender: SaltInboundSender;
  text: string;
  /** True iff this agent's own id is in message.mentions. In a group, an
   *  OpenClaw agent should only ever answer when this is true (or it's a
   *  DM) -- see skills/salt-etiquette/SKILL.md. */
  mentionsSelf: boolean;
  mentionedIds: string[];
  isLane: boolean;
  laneKind?: string;
  attachment?: SaltInboundAttachment;
  raw: { chatMeta?: RawChatMetaLike; message: Record<string, unknown> };
}

export interface ClassifyChatOptions {
  selfAgentId: string;
  /** Injectable member fetcher (salt-agent-sdk's `client.getChatMembers`).
   *  Only called when chatMeta carries no inline `users` -- exactly the
   *  fallback salt-agent-sdk's own `chatHasNonObserverHuman` uses. */
  fetchMembers?: (chatId: string) => Promise<Array<{ id: string; account_type?: string; observer?: boolean }>>;
}

function countNonObserverMembers(members: Array<{ observer?: boolean }>): number {
  return members.filter((m) => !m.observer).length;
}

/**
 * DM vs group classification.
 *
 * Best available signal, in order:
 *  1. Inline `chatMeta.users` (present on chat_opened, and useful in tests) --
 *     count non-observer members.
 *  2. `options.fetchMembers(chatId)` -- one REST round trip, same fallback
 *     salt-agent-sdk's own mention-gating uses.
 *  3. Heuristic on chatMeta alone: a 1:1 never carries a stored name
 *     (salt-fe's roomTitle note in CLAUDE.md), so `name`/`public`/
 *     `open_invite` present implies a group. This is a best-effort guess
 *     when no member data is available at all; see HANDOFF.md.
 */
export async function classifyChat(
  chatId: string,
  chatMeta: RawChatMetaLike | undefined,
  options: ClassifyChatOptions,
): Promise<SaltChatKind> {
  if (chatMeta?.users && chatMeta.users.length > 0) {
    return countNonObserverMembers(chatMeta.users) > 2 ? "group" : "dm";
  }
  if (options.fetchMembers) {
    const members = await options.fetchMembers(chatId);
    if (members.length > 0) {
      return countNonObserverMembers(members) > 2 ? "group" : "dm";
    }
  }
  if (chatMeta?.name || chatMeta?.public || chatMeta?.open_invite) return "group";
  return "dm";
}

export interface MapMessageEventOptions extends ClassifyChatOptions {
  /** Already-decrypted plaintext (mapping never touches ciphertext or keys). */
  decryptedText: string;
  attachment?: SaltInboundAttachment;
}

/**
 * Maps one decrypted `message` event into `SaltInboundMessage`, or `null`
 * when the row isn't a prompt at all (a system event, or this agent's own
 * echo -- dedup/self-echo is left to the caller since it needs the cursor,
 * not just this one row).
 */
export async function mapMessageEventToInbound(
  body: { message: Record<string, unknown>; chat?: RawChatMetaLike },
  options: MapMessageEventOptions,
): Promise<SaltInboundMessage | null> {
  const message = body.message;
  if (message.event_type) return null; // system event, not a prompt

  const chatId = String(message.chat_id);
  const chatMeta = body.chat;
  const senderRaw = message.user as RawSenderLike | undefined;
  if (!senderRaw) return null;

  const mentionedIds = (Array.isArray(message.mentions) ? (message.mentions as unknown[]) : []).map(String);
  const mentionsSelf = mentionedIds.some((id) => id.toLowerCase() === options.selfAgentId.toLowerCase());

  const kind = await classifyChat(chatId, chatMeta, options);
  const roomId = (chatMeta?.coaching_for_chat_id as string | undefined) ?? chatId;

  return {
    chatId,
    roomId,
    kind,
    sender: {
      id: String(senderRaw.id),
      handle: senderRaw.username,
      displayName: senderRaw.display_name,
      isAgent: senderRaw.account_type === "Agent",
    },
    text: options.decryptedText,
    mentionsSelf,
    mentionedIds,
    isLane: Boolean(chatMeta?.coaching_for_chat_id),
    laneKind: chatMeta?.lane_kind,
    attachment: options.attachment,
    raw: { chatMeta, message },
  };
}
