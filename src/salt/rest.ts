// Small REST helpers for salt-api endpoints salt-agent-sdk 0.7.1 doesn't
// wrap yet: the socket-mode long-poll contract itself (brand new -- see
// design-fleet/runs/2026-09-17-distribution/LANES.md's "Socket mode
// contract", built by a sibling lane in parallel with this plugin), the
// delivery-mode switch, a plain (non-invoice) payment request on the
// TransferRequest rail, and reactions. Everything else (postMessage,
// postCard/updateCard, signalTyping, wallets, ...) goes through
// salt-agent-sdk's own `createSaltClient` -- see src/channel.ts.
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

/** `PATCH /api/v1/agents/delivery {mode}` -- the setup step that puts this
 *  agent into socket mode instead of webhook delivery. Same auth as
 *  `PATCH /api/v1/agents/callback` (this agent's own api-key). */
export async function setDeliveryMode(
  options: SaltRestOptions,
  mode: "socket" | "webhook",
): Promise<unknown> {
  return saltRequest(options, "PATCH", "/api/v1/agents/delivery", { mode });
}

export interface SocketUpdateRow {
  id: string | number;
  delivery_id?: string;
  event: string;
  headers: Record<string, string>;
  body: string;
  created_at: string;
}

export interface FetchAgentUpdatesParams {
  /** Omit (or pass `undefined`) on a fresh start -- see socket-poller.ts's
   *  `pollOnce`, which is the only caller and already resolves a fresh/lost
   *  cursor to `undefined` rather than "0" (round-4 socket contract,
   *  LANES.md K2: an omitted `after` lets salt-api's own server-side ack
   *  apply instead of replaying up to 7 days of retained outbox). */
  after?: string;
  timeoutSeconds?: number;
  limit?: number;
}

export interface FetchAgentUpdatesResult {
  updates: SocketUpdateRow[];
  cursor: string;
}

/** `GET /api/v1/agent/updates?after=&timeout=&limit=` -- the socket-mode
 *  short-poll contract. `timeoutSeconds` is clamped server-side to 0-2s
 *  (round 3/4 revision -- it was a real long-poll clamped 0-25 before H1),
 *  `limit` 1-100; this helper does not re-validate, it just forwards. */
export async function fetchAgentUpdates(
  options: SaltRestOptions,
  params: FetchAgentUpdatesParams,
): Promise<FetchAgentUpdatesResult> {
  const query = new URLSearchParams();
  if (params.after !== undefined) query.set("after", params.after);
  if (params.timeoutSeconds !== undefined) query.set("timeout", String(params.timeoutSeconds));
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  return saltRequest(options, "GET", `/api/v1/agent/updates?${query.toString()}`);
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
 *  CLAUDE.md's Messaging extras. Not wrapped by salt-agent-sdk 0.7.1 yet. */
export async function addReaction(
  options: SaltRestOptions,
  messageId: string,
  emoji: string,
): Promise<unknown> {
  return saltRequest(options, "POST", `/api/v1/messages/${messageId}/reactions`, { emoji });
}
