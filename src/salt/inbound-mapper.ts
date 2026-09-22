// DM-vs-group classification and this plugin's own group-mention etiquette
// check, both built from the chat metadata salt-agent-sdk's `MessageContext`
// already hands over (channel.ts's onMessage) -- no crypto, no network
// (beyond the injectable `fetchMembers` fallback), so this stays a plain,
// easily unit-testable module.
//
// This module used to also map a raw, still-encrypted webhook/update body
// into an inbound shape (`mapMessageEventToInbound`) -- decrypt, sender,
// mentions array and all. That's gone now that receiving goes through
// salt-agent-sdk's `createSocketClient`: identity resolution, decrypt (or
// pass-through for an open room, `ctx.encrypted === false`), and dispatch
// all happen inside the SDK, and `channel.ts`'s onMessage handler is handed
// a `MessageContext` directly. One real loss from that: `MessageContext`
// does not expose the raw `message.mentions` id array the way a webhook
// body used to -- see `mentionsSelfByHandle` below for how this plugin
// approximates it instead.

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
  encrypted?: boolean;
  users?: Array<{ id: string; account_type?: string; observer?: boolean }>;
  [key: string]: unknown;
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

/**
 * Best-effort "was this agent @mentioned" check for a group message, from
 * plaintext alone.
 *
 * salt-agent-sdk's `MessageContext` (unlike the raw webhook/update body
 * this plugin used to parse itself) does not surface `message.mentions` --
 * the structured array of ids Salt's own clients resolve an "@handle" into
 * client-side (CLAUDE.md: "mentions are detected client-side, server sees
 * only ciphertext"). Without that array, the only signal left is a literal
 * "@handle" substring in the decrypted text -- a reasonable approximation
 * (every first-party Salt client writes the handle into the message body
 * itself, the ids array rides alongside it) but not exact: it can't catch
 * a mention Salt's own client attached without also writing "@handle" into
 * the text, and it can false-positive on a message that merely quotes
 * "@handle" without meaning to address this agent. Case-insensitive; the
 * handle must appear as its own token (not merely a substring of a longer
 * word), matching how "@handle" reads as one unit in a message.
 */
export function mentionsSelfByHandle(text: string, handle: string | undefined): boolean {
  if (!handle) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^a-zA-Z0-9_])@${escaped}(?![a-zA-Z0-9_])`, "i");
  return pattern.test(text);
}
