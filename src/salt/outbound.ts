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
  const members = await deps.getChatMembers(params.chatId);
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
  return deps.postMessage(params.chatId, message, senderMessage, params.mentions);
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
