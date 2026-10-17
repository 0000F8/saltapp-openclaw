// Outbound delivery: encrypt one reply for every current chat member (Salt
// is E2E -- there is no server-side fan-out), post it, and optionally
// signal typing. Deliberately independent of salt-agent-sdk's own
// `MessageContext.reply()` closure (which is tied to its webhook-server
// bot-loop model -- GACM, mediator gating, delegation trails; see
// HANDOFF.md for why this plugin does not reuse `createWebhookServer`
// wholesale) but built from the same two primitives it uses internally:
// `pgp.encryptFor` and `client.postMessage`.

export interface OutboundChatMember {
  id: string;
  publicKey?: string;
  /** The key's public fingerprint, sent back as the opt-in send guard. */
  fingerprint?: string;
}

/** The opt-in send guard (KEY_RESET_DESIGN.md 7): the fingerprint of every key the message was encrypted to. */
export interface SendGuard {
  recipientFingerprints?: Record<string, string>;
  senderFingerprint?: string;
}

/** Guard fields for a roster. Empty unless EVERY keyed member carries a fingerprint: a missing one must not read as stale. */
export function buildSendGuard(members: OutboundChatMember[], selfAgentId: string): SendGuard {
  const keyed = members.filter((m) => m.publicKey);
  if (!keyed.every((m) => m.fingerprint)) return {};
  const isSelf = (m: OutboundChatMember) => m.id.toLowerCase() === selfAgentId.toLowerCase();
  const guard: SendGuard = {
    recipientFingerprints: Object.fromEntries(keyed.filter((m) => !isSelf(m)).map((m) => [m.id, m.fingerprint as string])),
  };
  const me = keyed.find(isSelf);
  if (me) guard.senderFingerprint = me.fingerprint;
  return guard;
}

/** The 409 `stale_recipient_keys` refusal carries the current members; null for any other error. */
export function staleRecipientMembers(err: unknown): Array<{ id: string; public_key?: string; public_fingerprint?: string }> | null {
  const e = err as { status?: number; code?: string; body?: { code?: string; members?: unknown } } | undefined;
  if (!e || e.status !== 409) return null;
  if ((e.code ?? e.body?.code) !== "stale_recipient_keys") return null;
  return Array.isArray(e.body?.members) ? (e.body?.members as Array<{ id: string; public_key?: string; public_fingerprint?: string }>) : [];
}

export interface EncryptForMembersDeps {
  encryptFor: (plaintext: string, armoredPublicKeys: string[]) => Promise<string>;
}

export interface EncryptForMembersResult {
  /** Ciphertext every non-self member with a known key can decrypt. */
  message: string;
  /** This identity's own copy, encrypted to its own key (mirrors
   *  salt-agent-sdk's `senderMessage` -- lets the agent's own history
   *  contain its own sent text, decryptable after a restart). */
  senderMessage: string;
  /** Members skipped for having no known public key (e.g. a legacy
   *  pre-vault row, or a lookup gap) -- surfaced so a caller can log it
   *  instead of silently sending a reply some members can never read. */
  skippedMemberIds: string[];
}

/**
 * Encrypts `plaintext` for every OTHER member's key (never re-including the
 * agent's own key in that ciphertext -- salt-agent-sdk keeps those
 * separate on purpose so `senderMessage` alone is what this identity's
 * side reads back), plus a second copy encrypted to the agent's own key.
 */
export async function encryptForMembers(
  deps: EncryptForMembersDeps,
  plaintext: string,
  members: OutboundChatMember[],
  selfAgentId: string,
  selfPublicKey: string,
): Promise<EncryptForMembersResult> {
  const others = members.filter((m) => m.id.toLowerCase() !== selfAgentId.toLowerCase());
  const recipientKeys = others.filter((m) => m.publicKey).map((m) => m.publicKey as string);
  const skippedMemberIds = others.filter((m) => !m.publicKey).map((m) => m.id);

  if (recipientKeys.length === 0) {
    throw new Error("encryptForMembers: no recipient with a known public key -- refusing to send");
  }

  const [message, senderMessage] = await Promise.all([
    deps.encryptFor(plaintext, recipientKeys),
    deps.encryptFor(plaintext, [selfPublicKey]),
  ]);

  return { message, senderMessage, skippedMemberIds };
}

export interface SendReplyDeps extends EncryptForMembersDeps {
  getChatMembers: (chatId: string) => Promise<OutboundChatMember[]>;
  postMessage: (
    chatId: string,
    message: string,
    senderMessage: string,
    mentions?: string[],
    guard?: SendGuard,
  ) => Promise<unknown>;
  signalTyping?: (chatId: string) => Promise<void>;
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
}

export interface SendReplyParams {
  chatId: string;
  text: string;
  selfAgentId: string;
  selfPublicKey: string;
  mentions?: string[];
}

/**
 * Fetches the current member roster, encrypts `text` for all of them, and
 * posts it. This is the one path every outbound Salt message from this
 * plugin should go through -- the shared `message` tool's `sendText`
 * (src/channel.ts), the card/payment tools' confirmation text, and any
 * future plain-reply path.
 */
export async function sendEncryptedReply(deps: SendReplyDeps, params: SendReplyParams): Promise<unknown> {
  // Members are read now, at send time: never from a cache.
  let members = await deps.getChatMembers(params.chatId);
  for (let attempt = 0; ; attempt++) {
    const { message, senderMessage, skippedMemberIds } = await encryptForMembers(
      deps,
      params.text,
      members,
      params.selfAgentId,
      params.selfPublicKey,
    );
    if (skippedMemberIds.length > 0) {
      deps.logger?.error(
        `[chat ${params.chatId}] sending without ${skippedMemberIds.length} member(s) lacking a known public key: ${skippedMemberIds.join(", ")}`,
      );
    }
    try {
      return await deps.postMessage(params.chatId, message, senderMessage, params.mentions, buildSendGuard(members, params.selfAgentId));
    } catch (err) {
      const fresh = staleRecipientMembers(err);
      // Re-encrypt to the keys Salt sent back ONCE; a second refusal is thrown.
      if (!fresh || attempt > 0) throw err;
      members = members.map((m) => {
        const f = fresh.find((x) => String(x.id).toLowerCase() === m.id.toLowerCase());
        return f ? { ...m, publicKey: f.public_key ?? m.publicKey, fingerprint: f.public_fingerprint ?? m.fingerprint } : m;
      });
    }
  }
}

/** Best-effort typing signal; never throws (a typing indicator is a nicety,
 *  not something that should fail a reply). */
export async function signalTypingSafely(
  signalTyping: ((chatId: string) => Promise<void>) | undefined,
  chatId: string,
  logger?: { error: (msg: string) => void },
): Promise<void> {
  if (!signalTyping) return;
  try {
    await signalTyping(chatId);
  } catch (err) {
    logger?.error(`[chat ${chatId}] typing signal failed: ${(err as Error).message}`);
  }
}
