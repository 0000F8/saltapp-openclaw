// The Salt channel plugin object, following the shape
// docs/plugins/sdk-channel-plugins.md walks through in
// github.com/openclaw/openclaw: `config`/`setup` for account
// resolution and onboarding, `security.dm` for who may open a DM,
// `outbound.attachedResults` for the shared `message` tool's send path,
// and `registerFull` (wired from index.ts) for everything that needs the
// running plugin API -- starting the Salt socket connection and
// registering the two Salt-specific tools (post a card, request a
// payment).
//
// Receiving used to be this plugin's own hand-rolled short-poll loop
// (verify envelope HMAC, decrypt, map to an inbound shape). Owner rule:
// "DO NOT USE POLLING as a mechanic EVER." This now holds a single
// salt-agent-sdk `createSocketClient` connection -- a real Action Cable
// websocket to salt-api's `AgentUpdatesChannel` -- for the whole life of
// the process; an idle, caught-up agent makes zero requests. Envelope
// verification, decrypt-or-pass-through (open rooms), identity
// resolution, cursor persistence and dedupe are all the SDK's job now;
// this file's own onMessage handler only adds OpenClaw-specific policy on
// top (group @mention etiquette) and maps into OpenClaw's inbound shape.
// See HANDOFF.md.
//
// SDK-INTEGRATION-GUESS markers below call out exactly where this plugin
// guesses at the real compiled SDK's contract instead of citing verified
// doc text or bundled-plugin source. See HANDOFF.md's "Open questions".

import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";
import { runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import {
  createSaltClient,
  createSocketClient,
  encryptFor,
  FileCursorStore,
  FileDedupeStore,
  sameId,
  type AgentIdentity,
  type ChatOpenedContext,
  type IdentityStore,
  type MessageContext,
  type SaltClient,
  type SaltId,
  type SocketClient,
} from "salt-agent-sdk";
import { resolveSaltCursorDir } from "./salt/cursor-store.js";
import { classifyChat, mentionsSelfByHandle, type RawChatMetaLike } from "./salt/inbound-mapper.js";
import {
  createPaymentRequest,
  getPublicConfig,
  isOpenRoom,
  joinPublicChat,
  type SaltRestOptions,
} from "./salt/rest.js";
import { sendEncryptedReply, signalTypingSafely } from "./salt/outbound.js";
import { createSaltPostCardTool, createSaltRequestPaymentTool } from "./salt/tools.js";

export interface SaltInterests {
  mode: "addressed" | "keywords" | "all";
  keywords?: string[];
}

export interface SaltAccount {
  host: string;
  agentId: string;
  apiKey: string;
  privateKey: string;
  publicKey: string;
  passphrase: string;
  /** This agent's own Salt @handle (no leading @) -- used for this
   *  plugin's own group @mention etiquette (see inbound-mapper.ts's
   *  mentionsSelfByHandle). Without it, group messages are never
   *  answered. */
  handle?: string;
  /** Backfill page size when reconnecting with a stale cursor. NOT a poll
   *  interval -- the socket connection itself pushes; this only bounds
   *  how many rows one catch-up page fetches at a time. */
  pollLimit: number;
  verifySignatures: boolean;
  /** Join Salt's Commons (the shared open/unencrypted public room) on
   *  startup and apply `interests` to it. */
  joinCommons: boolean;
  /** This agent's delivery preference for open rooms -- applied to the
   *  Commons on join, and to any other open room this agent is later
   *  added to (see createChatOpenedHandler). */
  interests?: SaltInterests;
}

const REQUIRED_FIELDS = ["host", "agentId", "apiKey", "privateKey", "publicKey", "passphrase"] as const;

function saltSection(cfg: OpenClawConfig): Record<string, unknown> {
  return ((cfg.channels as Record<string, unknown> | undefined)?.salt as Record<string, unknown>) ?? {};
}

export function resolveAccount(cfg: OpenClawConfig, _accountId?: string | null): SaltAccount {
  const section = saltSection(cfg);
  for (const field of REQUIRED_FIELDS) {
    if (!section[field]) throw new Error(`salt: ${field} is required (set channels.salt.${field})`);
  }
  const interests = section.interests as { mode?: string; keywords?: string[] } | undefined;
  return {
    host: String(section.host),
    agentId: String(section.agentId),
    apiKey: String(section.apiKey),
    privateKey: String(section.privateKey),
    publicKey: String(section.publicKey),
    passphrase: String(section.passphrase),
    handle: section.handle ? String(section.handle) : undefined,
    // Backfill page size (SocketClientOptions#limit); 100 matches
    // salt-agent-sdk's own default.
    pollLimit: Number(section.pollLimit ?? 100),
    verifySignatures: section.verifySignatures !== false,
    joinCommons: section.joinCommons === true,
    interests: interests?.mode ? { mode: interests.mode as SaltInterests["mode"], keywords: interests.keywords } : undefined,
  };
}

export function inspectAccount(cfg: OpenClawConfig, _accountId?: string | null): Record<string, unknown> {
  const section = saltSection(cfg);
  const configured = REQUIRED_FIELDS.every((field) => Boolean(section[field]));
  return {
    enabled: Boolean(section.host),
    configured,
    apiKeyStatus: section.apiKey ? "available" : "missing",
    privateKeyStatus: section.privateKey ? "available" : "missing",
  };
}

// Filled in by startSaltChannel once the plugin actually starts (see that
// function). `saltChannelPlugin` below is built once, at module load time,
// before that ever runs -- `outbound.attachedResults.sendText`'s closure
// reads `runtimeRef.current` at CALL time rather than capturing it, so the
// ordering is fine (a plain module-scoped mutable box, not a stale
// closure-captured value).
const runtimeRef: { current?: SaltRuntimeDeps } = {};

export const saltChannelPlugin = createChatChannelPlugin<SaltAccount>({
  base: createChannelPluginBase<SaltAccount>({
    id: "salt",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount,
      inspectAccount,
    },
    setup: {
      applyAccountConfig: ({ cfg, input }) => ({
        ...cfg,
        channels: {
          ...(cfg.channels as Record<string, unknown> | undefined),
          salt: { ...saltSection(cfg), ...input },
        },
      }),
    },
  }),

  // Salt already gates who may open a chat with this agent server-side
  // (Block.between? refuses chat creation/reuse both ways -- see
  // CLAUDE.md's Privacy controls and blocking note); duplicating an
  // allowlist at the OpenClaw layer would be a second, easily-drifting
  // source of truth for the same decision salt-api already owns. This
  // wires the adapter anyway (a channel must declare SOME dm policy) but
  // leaves it permissive by default, with an optional config allowlist for
  // an operator who wants a stricter local policy on top.
  //
  // SDK-INTEGRATION-GUESS: `defaultPolicy: "open"` is this plugin's own
  // stand-in enum value (src/types/openclaw-plugin-sdk.d.ts) -- the real
  // doc example only shows `"allowlist"`. Verify the real allowed values
  // before shipping.
  security: {
    dm: {
      channelKey: "salt",
      resolvePolicy: (account) => (account as unknown as { dmPolicy?: string }).dmPolicy,
      resolveAllowFrom: () => [],
      defaultPolicy: "open",
    },
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    attachedResults: {
      channel: "salt",
      // SDK-INTEGRATION-GUESS: the doc's `sendText` receives `params.to`/
      // `params.text` and nothing else; no `context` argument gives this
      // closure the running client/identity directly, so it reads
      // `runtimeRef.current` (set once by startSaltChannel) instead. The
      // actual branching logic is `sendChannelText` below, kept separate
      // and directly unit-testable with mock deps rather than requiring a
      // full `startSaltChannel` (which opens a real socket).
      sendText: async (params) => {
        const deps = runtimeRef.current;
        if (!deps) {
          throw new Error(
            "salt channel plugin: outbound.attachedResults.sendText was called before the channel finished " +
              `starting (registerFull's startSaltChannel hasn't run yet). Attempted to send to ${params.to}.`,
          );
        }
        return sendChannelText(deps, params);
      },
    },
  },
});

// ---------------------------------------------------------------------
// Runtime wiring: socket connection + tools. Called from index.ts's
// `registerFull`, which is the doc's designated place for anything that
// needs the live plugin API rather than just manifest/schema metadata.
// ---------------------------------------------------------------------

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

export interface SaltRuntimeDeps {
  client: SaltClient;
  identity: AgentIdentity;
  restOptions: SaltRestOptions;
  account: SaltAccount;
  logger?: Logger;
}

export function createSaltRuntimeDeps(api: OpenClawPluginApi): SaltRuntimeDeps {
  const cfg = api.runtime.config.current();
  const account = resolveAccount(cfg);
  const client = createSaltClient({ host: account.host });
  const restOptions: SaltRestOptions = { host: account.host, apiKey: account.apiKey };
  const identity: AgentIdentity = {
    saltAppId: account.agentId,
    // AgentIdentity.username is required by the SDK but this plugin's own
    // config never collects a real Salt username -- only `handle`
    // (optional, used for this plugin's own @mention heuristic). Falling
    // back to agentId here is safe: the SDK only uses `username` for
    // logging/health-endpoint display, never for decrypt/routing (that's
    // saltAppId).
    username: account.handle ?? account.agentId,
    apiKey: account.apiKey,
    publicKey: account.publicKey,
    privateKey: account.privateKey,
  };
  return { client, restOptions, account, identity, logger: console };
}

/** A one-identity IdentityStore, kept in memory only -- this plugin's
 *  "self-held custody" model already stores the private key exactly once,
 *  in OpenClaw's own config/secret storage (see README.md's Custody
 *  section); writing a second copy to a JSON file the way
 *  salt-agent-sdk's own file-backed `createIdentityStore` does would
 *  duplicate that secret on disk for no benefit (this plugin never spawns
 *  additional identities at runtime the way salt-claude-agent's roster
 *  can). */
function createSingleIdentityStore(identity: AgentIdentity): IdentityStore {
  let current = identity;
  return {
    register(next) {
      current = next;
    },
    get(id) {
      return sameId(id, current.saltAppId) ? current : undefined;
    },
    all() {
      return [current];
    },
    reassignId(from, to) {
      if (!sameId(from, current.saltAppId)) return undefined;
      current = { ...current, saltAppId: to };
      return current;
    },
  };
}

/**
 * Wires the SDK's onMessage handler: this plugin's own group @mention
 * etiquette (a DM is always answered; a group message is answered only
 * when this agent's configured `handle` appears as "@handle" in the
 * plaintext -- see inbound-mapper.ts's mentionsSelfByHandle for why this
 * is a heuristic, not an exact mentions-array check), then a best-effort
 * typing signal, then the shared dispatch into OpenClaw's own agent turn
 * pipeline. Self-echo, system events, and hand-off/session-note wire
 * markers are already filtered out one layer up, inside the SDK's own
 * dispatcher, before onMessage is ever called -- this handler only sees
 * real prompts from someone else.
 */
export function createMessageHandler(deps: SaltRuntimeDeps) {
  let warnedNoHandle = false;
  return async (ctx: MessageContext): Promise<void> => {
    const chatId = String(ctx.chatId);
    const kind = await classifyChat(chatId, ctx.chatMeta as RawChatMetaLike | undefined, {
      selfAgentId: deps.account.agentId,
      fetchMembers: async (id) => {
        const members = await deps.client.getChatMembers(deps.account.apiKey, id as SaltId);
        return members.map((m) => ({ id: String(m.id), account_type: m.account_type }));
      },
    });

    // mentionsSelf always reflects the literal "@handle" heuristic (see
    // mentionsSelfByHandle) -- independent of DM vs group, same as the raw
    // mentions-array field this replaced used to be. It's the GATE below,
    // not this value, that decides whether a group message forwards at
    // all: a DM always forwards regardless of mentionsSelf.
    const mentionsSelf = mentionsSelfByHandle(ctx.text, deps.account.handle);
    if (kind === "group" && !mentionsSelf) {
      if (!deps.account.handle && !warnedNoHandle) {
        warnedNoHandle = true;
        deps.logger?.error(
          '[salt] a group message arrived with no configured "handle" -- this agent cannot tell whether it was ' +
            "@mentioned, so group messages will not be answered until channels.salt.handle is set to this agent's " +
            "own Salt @handle. DMs are unaffected.",
        );
      }
      return;
    }

    await signalTypingSafely((id) => deps.client.signalTyping(deps.account.apiKey, id as SaltId), chatId, deps.logger);

    // SDK-INTEGRATION-GUESS: see src/types/openclaw-plugin-sdk.d.ts's
    // comment on `runChannelInboundEvent` -- this call's parameter shape
    // is unverified against the real compiled host.
    await runChannelInboundEvent({
      channelId: "salt",
      raw: {
        chatMeta: ctx.chatMeta,
        sender: ctx.sender,
        encrypted: ctx.encrypted,
        roomId: ctx.roomId,
        // Open rooms (interests): why THIS delivery reached this agent --
        // "mention"/"reply"/"keyword"/"all" -- present only alongside
        // `encrypted: false` (salt-agent-sdk 0.10.1's
        // MessageContext.deliveredBecause; undefined for an ordinary
        // encrypted chat, where every member gets every message). Read via
        // a loose cast rather than the typed field: at the time this was
        // written, salt-agent-sdk's own compiled `dist/` (what this
        // plugin's `node_modules/salt-agent-sdk` symlink resolves to)
        // still predated the commit that added this field to `src/`, so
        // depending on the typed property failed the build here even
        // though the field is real and merged. Once that sibling repo's
        // own `dist/` is rebuilt (its own lane's responsibility, not this
        // plugin's), the real value flows through with no change needed.
        deliveredBecause: (ctx as unknown as { deliveredBecause?: string }).deliveredBecause,
      },
      chatId,
      senderId: String(ctx.senderId),
      text: ctx.text,
      isGroup: kind === "group",
      mentionsSelf,
    });
  };
}

/**
 * Open rooms (b, interests): when this agent is newly added to a chat that
 * turns out to be an open room, apply its configured `interests` to it
 * automatically -- the same subscription "join the Commons" applies at
 * startup, generalized to any open room this agent joins later (a group
 * invite, not just the Commons).
 */
export function createChatOpenedHandler(deps: SaltRuntimeDeps) {
  return async (ctx: ChatOpenedContext): Promise<void> => {
    if (!deps.account.interests) return;
    const chat = ctx.chat as { encrypted?: boolean };
    if (chat.encrypted !== false) return; // only an open room carries a subscription at all
    try {
      await deps.client.setChatSubscription(deps.account.apiKey, ctx.chatId, deps.account.interests);
    } catch (err) {
      deps.logger?.error(`[salt] setChatSubscription for newly-opened open room ${ctx.chatId} failed: ${(err as Error).message}`);
    }
  };
}

/** "Join the Commons" setup step (e): reads `commons_chat_id` off the
 *  public `GET /api/v1/config`, joins it, and applies `interests` to it.
 *  Best-effort -- logged and swallowed on failure so a Commons outage or
 *  an unconfigured deployment never blocks the plugin from loading. */
async function joinCommons(deps: SaltRuntimeDeps): Promise<void> {
  try {
    const cfg = await getPublicConfig(deps.restOptions);
    if (!cfg.commons_chat_id) {
      deps.logger?.error("[salt] joinCommons is set but GET /api/v1/config returned no commons_chat_id -- nothing to join.");
      return;
    }
    await joinPublicChat(deps.restOptions, cfg.commons_chat_id);
    deps.logger?.info(`[salt] joined the Commons (chat ${cfg.commons_chat_id}).`);
    if (deps.account.interests) {
      await deps.client.setChatSubscription(deps.account.apiKey, cfg.commons_chat_id, deps.account.interests);
    }
  } catch (err) {
    deps.logger?.error(`[salt] joining the Commons failed (continuing anyway): ${(err as Error).message}`);
  }
}

export async function startSaltChannel(api: OpenClawPluginApi): Promise<{ stop: () => Promise<void> }> {
  const deps = createSaltRuntimeDeps(api);
  runtimeRef.current = deps;

  // Setup step: put this agent into socket mode. Best-effort -- a repeat
  // call is idempotent server-side, and a failure here should not stop the
  // plugin from loading; it's logged and the socket connection starts
  // regardless.
  try {
    await deps.client.setDeliveryMode(deps.account.apiKey, "socket");
  } catch (err) {
    deps.logger?.error(`[salt] setDeliveryMode(socket) failed (continuing anyway): ${(err as Error).message}`);
  }

  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const cursorDir = resolveSaltCursorDir(stateDir);
  const identities = createSingleIdentityStore(deps.identity);

  // The Salt socket connection itself: a real Action Cable websocket held
  // open for the life of this process (salt-agent-sdk's
  // `createSocketClient`). No timer of its own -- salt-api pushes each
  // envelope the instant it's written; an idle, caught-up agent makes
  // zero requests. This is the entire replacement for the old
  // socket-poller.ts long-poll loop.
  const socket: SocketClient = createSocketClient({
    host: deps.account.host,
    apiKey: deps.account.apiKey,
    agentId: deps.account.agentId,
    client: deps.client,
    identities,
    pgpPassphrase: deps.account.passphrase,
    verifySignatures: deps.account.verifySignatures,
    limit: deps.account.pollLimit,
    // Rooted in OpenClaw's own plugin state dir, same property the old
    // hand-rolled cursor file had: a restart resumes where it left off
    // instead of replaying Salt's retained outbox.
    cursorStore: FileCursorStore(cursorDir),
    dedupeStore: FileDedupeStore(cursorDir),
    logger: deps.logger,
    onMessage: createMessageHandler(deps),
    onChatOpened: createChatOpenedHandler(deps),
  });
  socket.start();

  if (deps.account.joinCommons) {
    // Fire-and-forget at startup: never block plugin load on a Commons
    // round trip. Failures are logged inside joinCommons itself.
    void joinCommons(deps);
  }

  const resolveCurrentChatId = (_context: unknown): string | undefined => {
    // SDK-INTEGRATION-GUESS: the real per-turn tool context's "current
    // chat id" accessor is unverified -- see HANDOFF.md. The two Salt
    // tools refuse to run (return null) rather than guess a chat id, so
    // this returning undefined fails closed, not open.
    return undefined;
  };

  api.registerTool(
    createSaltPostCardTool({
      resolveCurrentChatId,
      postCard: (chatId, blocks, text) => deps.client.postCard(deps.account.apiKey, chatId, blocks, text),
      updateCard: (cardId, blocks) => deps.client.updateCard(deps.account.apiKey, cardId, blocks),
      restOptions: deps.restOptions,
    }),
    { name: "salt_post_card" },
  );

  api.registerTool(
    createSaltRequestPaymentTool({
      resolveCurrentChatId,
      postCard: (chatId, blocks, text) => deps.client.postCard(deps.account.apiKey, chatId, blocks, text),
      updateCard: (cardId, blocks) => deps.client.updateCard(deps.account.apiKey, cardId, blocks),
      restOptions: deps.restOptions,
    }),
    { name: "salt_request_payment" },
  );

  return { stop: () => socket.stop() };
}

/**
 * The shared `message` tool's outbound path (open rooms, plaintext out):
 * branches on whether `params.to` is currently an open room
 * (`rest.ts#isOpenRoom`, which fails closed -- an unreadable lookup is
 * treated as "still encrypted" rather than risking a plaintext leak into a
 * real E2E chat) and posts plain via `client.postPlainMessage` there, or
 * PGP-encrypted via `createReplySender` (below) everywhere else. Kept as
 * its own function, separate from the `outbound.attachedResults.sendText`
 * closure above, so it's directly unit-testable with mock deps instead of
 * requiring a full `startSaltChannel` (which opens a real socket).
 */
export async function sendChannelText(
  deps: SaltRuntimeDeps,
  params: { to: string; text: string },
): Promise<{ messageId?: string; [key: string]: unknown }> {
  const open = await isOpenRoom(deps.restOptions, params.to, deps.logger);
  const posted = open
    ? await deps.client.postPlainMessage(deps.account.apiKey, params.to, params.text)
    : await createReplySender(deps)(params.to, params.text);
  const id = (posted as { id?: string } | undefined)?.id;
  return id ? { messageId: id } : {};
}

// Re-exported for outbound.ts callers wired directly against a running
// SaltClient (kept here so index.ts has one place to build the full reply
// path without re-deriving `encryptFor`/`sendEncryptedReply` wiring), and
// reused directly by `sendChannelText` above for the encrypted-chat
// branch.
export function createReplySender(deps: SaltRuntimeDeps) {
  return (chatId: string, text: string, mentions?: string[]) =>
    sendEncryptedReply(
      {
        encryptFor,
        getChatMembers: async (id) => {
          const members = await deps.client.getChatMembers(deps.account.apiKey, id as SaltId);
          return members.map((m) => ({ id: String(m.id), publicKey: m.public_key }));
        },
        postMessage: (id, message, senderMessage, mentionIds) =>
          deps.client.postMessage(deps.account.apiKey, id as SaltId, message, senderMessage, undefined, mentionIds as SaltId[] | undefined),
        logger: deps.logger,
      },
      { chatId, text, selfAgentId: deps.account.agentId, selfPublicKey: deps.account.publicKey, mentions },
    );
}
