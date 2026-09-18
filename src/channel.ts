// The Salt channel plugin object, following the shape
// docs/plugins/sdk-channel-plugins.md walks through in
// github.com/openclaw/openclaw: `config`/`setup` for account
// resolution and onboarding, `security.dm` for who may open a DM,
// `outbound.attachedResults` for the shared `message` tool's send path,
// and `registerFull` (wired from index.ts) for everything that needs the
// running plugin API -- starting the socket-mode long-poll bridge and
// registering the two Salt-specific tools (post a card, request a
// payment).
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
import { createSaltClient, decrypt, encryptFor, type SaltClient } from "salt-agent-sdk";
import { createFileCursorStore, resolveSaltCursorDir } from "./salt/cursor-store.js";
import { mapMessageEventToInbound, type RawChatMetaLike } from "./salt/inbound-mapper.js";
import {
  fetchAgentUpdates,
  setDeliveryMode,
  type SaltRestOptions,
} from "./salt/rest.js";
import { createSocketPoller, type VerifiedUpdate } from "./salt/socket-poller.js";
import { sendEncryptedReply, signalTypingSafely } from "./salt/outbound.js";
import { createSaltPostCardTool, createSaltRequestPaymentTool } from "./salt/tools.js";

export interface SaltAccount {
  host: string;
  agentId: string;
  apiKey: string;
  privateKey: string;
  publicKey: string;
  passphrase: string;
  pollTimeoutSeconds: number;
  pollLimit: number;
  verifySignatures: boolean;
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
  return {
    host: String(section.host),
    agentId: String(section.agentId),
    apiKey: String(section.apiKey),
    privateKey: String(section.privateKey),
    publicKey: String(section.publicKey),
    passphrase: String(section.passphrase),
    pollTimeoutSeconds: Number(section.pollTimeoutSeconds ?? 25),
    pollLimit: Number(section.pollLimit ?? 50),
    verifySignatures: section.verifySignatures !== false,
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
      // `params.text` and nothing else; this plugin does NOT yet have a
      // verified way to recover the current account's client/identity
      // from inside this closure alone (no `context` argument shown in
      // the doc's example). `createRuntimeSaltDeps` below is the real,
      // fully-wired send path used by the socket bridge's own replies;
      // wire this closure to the same running client once that accessor
      // is confirmed. See HANDOFF.md.
      sendText: async (params) => {
        throw new Error(
          "salt channel plugin: outbound.attachedResults.sendText is not wired yet -- " +
            "see HANDOFF.md's open questions (recovering the running SaltClient/identity " +
            `from this closure). Attempted to send to ${params.to}.`,
        );
      },
    },
  },
});

// ---------------------------------------------------------------------
// Runtime wiring: socket bridge + tools. Called from index.ts's
// `registerFull`, which is the doc's designated place for anything that
// needs the live plugin API rather than just manifest/schema metadata.
// ---------------------------------------------------------------------

export interface SaltRuntimeDeps {
  client: SaltClient;
  restOptions: SaltRestOptions;
  account: SaltAccount;
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
  /** Injectable so tests can stub decryption instead of round-tripping
   *  real OpenPGP through fake ciphertext. Defaults to salt-agent-sdk's
   *  own `decrypt`. */
  decrypt: (armoredMessage: string, armoredPrivateKey: string, passphrase: string) => Promise<string>;
}

export function createSaltRuntimeDeps(api: OpenClawPluginApi): SaltRuntimeDeps {
  const cfg = api.runtime.config.current();
  const account = resolveAccount(cfg);
  const client = createSaltClient({ host: account.host });
  const restOptions: SaltRestOptions = { host: account.host, apiKey: account.apiKey };
  return { client, restOptions, account, logger: console, decrypt };
}

/**
 * Wires one poll->verify->decrypt->map->dispatch cycle's `onUpdate`
 * handler. Split out from `startSaltChannel` so it's independently
 * testable without a real long-poll loop (see channel.test.ts).
 */
export function createUpdateHandler(deps: SaltRuntimeDeps, api: OpenClawPluginApi) {
  return async (update: VerifiedUpdate): Promise<void> => {
    if (update.event !== "message") {
      // card_interaction / invoice_paid / chat_opened / handoff_* events
      // ride the same envelope but need their own OpenClaw-side surfaces
      // (a card action, a notification, a fresh conversation greeting).
      // Only plain messages are mapped to the shared inbound turn pipeline
      // today -- see HANDOFF.md.
      deps.logger?.info(`[salt] ignoring unmapped event kind: ${update.event}`);
      return;
    }

    const body = update.body as { message: Record<string, unknown>; chat?: RawChatMetaLike };
    const ciphertext = body.message?.message;
    if (typeof ciphertext !== "string") return;

    const decryptedText = await deps.decrypt(ciphertext, deps.account.privateKey, deps.account.passphrase);

    const inbound = await mapMessageEventToInbound(body, {
      selfAgentId: deps.account.agentId,
      decryptedText,
      fetchMembers: async (chatId) => {
        const members = await deps.client.getChatMembers(deps.account.apiKey, chatId);
        return members.map((m) => ({ id: String(m.id), account_type: m.account_type }));
      },
    });
    if (!inbound) return;

    // Never auto-answer an unaddressed message in a group -- agents in
    // groups only see @mentions; see skills/salt-etiquette/SKILL.md.
    if (inbound.kind === "group" && !inbound.mentionsSelf) return;
    // Our own echo (this agent is also a chat member, so its own posted
    // reply comes back through the same feed) -- never reply to ourselves.
    if (inbound.sender.id.toLowerCase() === deps.account.agentId.toLowerCase()) return;

    await signalTypingSafely(
      (chatId) => deps.client.signalTyping(deps.account.apiKey, chatId),
      inbound.chatId,
      deps.logger,
    );

    // SDK-INTEGRATION-GUESS: see src/types/openclaw-plugin-sdk.d.ts's
    // comment on `runChannelInboundEvent` -- this call's parameter shape
    // is unverified against the real compiled host.
    await runChannelInboundEvent({
      channelId: "salt",
      raw: inbound.raw,
      chatId: inbound.chatId,
      senderId: inbound.sender.id,
      text: inbound.text,
      isGroup: inbound.kind === "group",
      mentionsSelf: inbound.mentionsSelf,
    });
  };
}

export async function startSaltChannel(api: OpenClawPluginApi): Promise<{ stop: () => void }> {
  const deps = createSaltRuntimeDeps(api);

  // Setup step: put this agent into socket mode. Best-effort -- a repeat
  // call is idempotent server-side, and a failure here (e.g. the socket
  // lane's PATCH route not deployed yet) should not stop the plugin from
  // loading; it's logged and the poller is started regardless, so a race
  // against that rollout self-heals on the operator's next restart.
  try {
    await setDeliveryMode(deps.restOptions, "socket");
  } catch (err) {
    deps.logger?.error(`[salt] setDeliveryMode(socket) failed (continuing anyway): ${(err as Error).message}`);
  }

  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const cursorDir = resolveSaltCursorDir(stateDir);
  const cursorStore = createFileCursorStore(cursorDir);

  const onUpdate = createUpdateHandler(deps, api);

  const handle = createSocketPoller(
    {
      fetchUpdates: (after, timeoutSeconds, limit) =>
        fetchAgentUpdates(deps.restOptions, { after, timeoutSeconds, limit }),
      getSigningSecret: () => deps.client.getWebhookSecret(deps.account.apiKey),
      cursorStore,
      onUpdate,
      logger: deps.logger,
      toleranceSeconds: 300,
    },
    {
      timeoutSeconds: deps.account.pollTimeoutSeconds,
      limit: deps.account.pollLimit,
    },
  );

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

  return { stop: () => handle.stop() };
}

// Re-exported for outbound.ts callers wired directly against a running
// SaltClient (kept here so index.ts has one place to build the full reply
// path without re-deriving `encryptFor`/`sendEncryptedReply` wiring).
export function createReplySender(deps: SaltRuntimeDeps) {
  return (chatId: string, text: string, mentions?: string[]) =>
    sendEncryptedReply(
      {
        encryptFor,
        getChatMembers: async (id) => {
          const members = await deps.client.getChatMembers(deps.account.apiKey, id);
          return members.map((m) => ({ id: String(m.id), publicKey: m.public_key }));
        },
        postMessage: (id, message, senderMessage, mentionIds) =>
          deps.client.postMessage(deps.account.apiKey, id, message, senderMessage, undefined, mentionIds),
        logger: deps.logger,
      },
      { chatId, text, selfAgentId: deps.account.agentId, selfPublicKey: deps.account.publicKey, mentions },
    );
}
