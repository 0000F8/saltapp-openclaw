// Small REST helpers for salt-api endpoints salt-agent-sdk 0.10.0 doesn't
// wrap yet: a plain (non-invoice) payment request on the TransferRequest
// rail, reactions, reading a chat's `encrypted` flag (open rooms), and the
// Commons (the shared public room -- `GET /api/v1/config`'s
// `commons_chat_id` plus joining it).
//
// The socket-mode long-poll contract itself and the delivery-mode switch
// (`setDeliveryMode`) used to live here too -- both are now
// salt-agent-sdk's job (`createSocketClient`, `client.setDeliveryMode`),
// since this plugin no longer hand-rolls polling. See channel.ts.
//
// Kept deliberately thin and dependency-free (plain `fetch`, injectable for
// tests) rather than reaching into salt-agent-sdk's unexported internal
// `request()` helper.

export class SaltRestError extends Error {
  constructor(
    public readonly method: string,
    public readonly url: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(`${method} ${url} -> ${status}${body ? `: ${body}` : ""}`);
    this.name = "SaltRestError";
  }
}

export interface SaltRestOptions {
  host: string;
  apiKey: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

async function saltRequest<T>(
  options: SaltRestOptions,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.host.replace(/\/+$/, "")}${urlPath}`;
  const res = await doFetch(url, {
    method,
    headers: {
      "api-key": options.apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => undefined);
    throw new SaltRestError(method, url, res.status, text);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface CreatePaymentRequestParams {
  chatId: string;
  /** One of this agent's own active wallet ids -- the wallet the payment
   *  should land in. */
  walletId: string;
  /** The chat member being asked to pay (transfer_requests_controller
   *  names this `receiver_id`, confusingly from the payer's perspective --
   *  it is who this agent, as `sender`, is requesting funds FROM). */
  payerId: string;
  /** Human-decimal string, e.g. "12.50". */
  amount: string;
  message?: string;
}

/** `POST /api/v1/transfer_requests` -- a plain (non-invoice) in-chat
 *  payment request. Read directly from
 *  app/controllers/api/v1/transfer_requests_controller.rb#create: passing
 *  `chat_id` without `request_type: "invoice"` takes the plain-request
 *  branch (`TransferRequest.create_in_chat!` with no line_items). */
export async function createPaymentRequest(
  options: SaltRestOptions,
  params: CreatePaymentRequestParams,
): Promise<unknown> {
  return saltRequest(options, "POST", "/api/v1/transfer_requests", {
    chat_id: params.chatId,
    wallet_id: params.walletId,
    receiver_id: params.payerId,
    amount: params.amount,
    message: params.message,
  });
}

/** `POST /api/v1/messages/:id/reactions` -- toggle semantics per
 *  CLAUDE.md's Messaging extras. Not wrapped by salt-agent-sdk yet. */
export async function addReaction(
  options: SaltRestOptions,
  messageId: string,
  emoji: string,
): Promise<unknown> {
  return saltRequest(options, "POST", `/api/v1/messages/${messageId}/reactions`, { emoji });
}

export interface SaltChatInfo {
  id: string;
  /** False for an open room -- plain text, no PGP (salt-api 0.81.0's open
   *  rooms). Absent/true for an ordinary end-to-end encrypted chat.
   *  salt-agent-sdk's own `SaltChat` type doesn't type this field yet
   *  either (both read it through the same untyped-catch-all shape). */
  encrypted?: boolean;
  [key: string]: unknown;
}

/** `GET /api/v1/chats/:id` -- used here only to read the chat-level
 *  `encrypted` flag (open rooms) before deciding whether a reply should be
 *  posted plain (`client.postPlainMessage`) or PGP-encrypted
 *  (`client.postMessage`/`ctx.reply`). salt-agent-sdk's own
 *  `client.getChatMembers`/`getChatMessages` fetch the same resource but
 *  throw the rest of it away. */
export async function getChat(options: SaltRestOptions, chatId: string): Promise<SaltChatInfo> {
  return saltRequest(options, "GET", `/api/v1/chats/${chatId}?_=${Date.now()}`);
}

/** Best-effort: is `chatId` an open room right now? Fails closed (treats an
 *  unreadable/errored lookup as "not open", i.e. still requiring
 *  encryption) rather than risking a plaintext send into what might
 *  actually be an end-to-end encrypted chat. */
export async function isOpenRoom(options: SaltRestOptions, chatId: string, logger?: { error: (msg: string) => void }): Promise<boolean> {
  try {
    const chat = await getChat(options, chatId);
    return chat.encrypted === false;
  } catch (err) {
    logger?.error(`[salt] could not determine whether chat ${chatId} is an open room (assuming encrypted): ${(err as Error).message}`);
    return false;
  }
}

export interface SaltPublicConfig {
  /** The id of Salt's Commons -- the one shared, open (unencrypted) public
   *  room every agent can ask to join. Absent on a deployment with no
   *  Commons configured. */
  commons_chat_id?: string;
  [key: string]: unknown;
}

/** `GET /api/v1/config` -- unauthenticated, public. Read here only for
 *  `commons_chat_id`; salt-agent-sdk doesn't wrap this endpoint (it's
 *  mostly client-app configuration, not an agent concern) except for this
 *  one field this plugin's "join the Commons" setup step needs. */
export async function getPublicConfig(options: Pick<SaltRestOptions, "host" | "fetchImpl">): Promise<SaltPublicConfig> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.host.replace(/\/+$/, "")}/api/v1/config`;
  const res = await doFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => undefined);
    throw new SaltRestError("GET", url, res.status, text);
  }
  return (await res.json()) as SaltPublicConfig;
}

/**
 * `POST /api/v1/chats/:id/join_public` -- joins this agent to an open
 * public room (the Commons, or any other `open_invite`/public chat) it
 * isn't already a member of. Idempotent-in-spirit (an already-a-member
 * call should be a harmless no-op on salt-api's side); this helper does
 * not itself special-case a 409/422 "already a member" response beyond
 * letting it surface as a SaltRestError for the caller to log and ignore.
 *
 * API-CONTRACT-GUESS: the exact route/verb for "join a public chat" is
 * inferred from the naming this plugin's task brief used ("joins via
 * join_public") and from salt-api's existing action-route convention
 * (`/sidechain`, `/typing`, `/hide`, `/lock` -- a POST to a sub-resource
 * named after the verb, no body). Not independently confirmed against
 * salt-api 0.81.0 source (not available in this checkout at write time --
 * that work was still in flight on a sibling lane). Verify this path once
 * salt-api's Commons routes ship; see HANDOFF.md.
 */
export async function joinPublicChat(options: SaltRestOptions, chatId: string): Promise<unknown> {
  return saltRequest(options, "POST", `/api/v1/chats/${chatId}/join_public`);
}
