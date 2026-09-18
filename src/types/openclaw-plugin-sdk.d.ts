/**
 * Hand-written stand-in types for the slice of `openclaw/plugin-sdk/*` this
 * plugin imports.
 *
 * WHY THIS FILE EXISTS: `openclaw` is not resolvable from the public npm
 * registry at a version that matches this plugin's target (`compat.pluginApi
 * >= 2026.9.4`) from outside an OpenClaw checkout, and the real SDK's public
 * types live across dozens of narrow subpaths (see
 * `docs/plugins/sdk-channel-plugins.md` and `docs/plugins/sdk-runtime/*` in
 * github.com/openclaw/openclaw). Rather than vendor or fake the whole SDK,
 * this file declares only the shapes `src/channel.ts`, `index.ts`, and
 * `setup-entry.ts` actually touch, modeled directly on the documented
 * examples and on the bundled Signal/WhatsApp/Telegram channel plugins' own
 * source (see HANDOFF.md's "Open questions" for exactly which calls are
 * unverified against a real compiled host).
 *
 * Delete this file and let `openclaw`'s real published types take over once
 * this plugin is built/tested inside an actual OpenClaw plugin dev harness.
 */

declare module "openclaw/plugin-sdk/channel-core" {
  export type OpenClawConfig = {
    channels?: Record<string, unknown>;
    plugins?: { entries?: Record<string, unknown> };
    [key: string]: unknown;
  };

  export interface ChannelSecurityDmOptions<TAccount> {
    channelKey: string;
    resolvePolicy: (account: TAccount) => string | undefined;
    resolveAllowFrom: (account: TAccount) => string[];
    defaultPolicy: "allowlist" | "open" | "closed";
  }

  export interface ChannelOutboundSendTextParams {
    to: string;
    text: string;
    [key: string]: unknown;
  }

  export interface ChannelOutboundSendTextResult {
    messageId?: string;
    [key: string]: unknown;
  }

  export interface ChannelOutboundAttachedResults {
    channel: string;
    sendText: (
      params: ChannelOutboundSendTextParams,
    ) => Promise<ChannelOutboundSendTextResult>;
  }

  export interface ChannelOutboundBase {
    sendMedia?: (params: { to: string; filePath: string; [key: string]: unknown }) => Promise<void>;
  }

  export interface ChannelPluginBaseConfig<TAccount> {
    id: string;
    config: {
      listAccountIds: () => string[];
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
      inspectAccount?: (
        cfg: OpenClawConfig,
        accountId?: string | null,
      ) => Record<string, unknown>;
    };
    setup: {
      applyAccountConfig: (params: {
        cfg: OpenClawConfig;
        input: Record<string, unknown>;
      }) => OpenClawConfig;
    };
  }

  export function createChannelPluginBase<TAccount>(
    config: ChannelPluginBaseConfig<TAccount>,
  ): ChannelPluginBaseConfig<TAccount>;

  export interface ChatChannelPluginOptions<TAccount> {
    base: ChannelPluginBaseConfig<TAccount>;
    security?: { dm: ChannelSecurityDmOptions<TAccount> };
    pairing?: {
      text?: {
        idLabel: string;
        message: string;
        notify: (params: { target: string; code: string }) => Promise<void>;
      };
    };
    threading?: { topLevelReplyToMode: "reply" | "quote" | string };
    outbound?: {
      attachedResults?: ChannelOutboundAttachedResults;
      base?: ChannelOutboundBase;
    };
    capabilities?: { chatTypes?: string[] };
  }

  export interface ChannelPlugin<TAccount> {
    id: string;
    config: ChannelPluginBaseConfig<TAccount>["config"];
    setup: ChannelPluginBaseConfig<TAccount>["setup"];
    [key: string]: unknown;
  }

  export function createChatChannelPlugin<TAccount>(
    options: ChatChannelPluginOptions<TAccount>,
  ): ChannelPlugin<TAccount>;

  export function defineChannelPluginEntry(options: {
    id: string;
    name: string;
    description: string;
    plugin: ChannelPlugin<unknown>;
    registerCliMetadata?: (api: OpenClawPluginApi) => void;
    registerFull?: (api: OpenClawPluginApi) => void | Promise<void>;
  }): unknown;

  export function defineSetupPluginEntry(plugin: ChannelPlugin<unknown>): unknown;

  export interface OpenClawPluginApi {
    config: OpenClawConfig;
    registerTool: (
      factory: (context: OpenClawPluginToolContext) => AnyAgentTool | null,
      options: { name: string },
    ) => void;
    registerHttpRoute?: (route: {
      path: string;
      auth: "plugin" | "gateway";
      handler: (req: unknown, res: unknown) => Promise<boolean> | boolean;
    }) => void;
    registerCli?: (build: (helpers: { program: unknown }) => void, options?: Record<string, unknown>) => void;
    runtime: {
      state: {
        resolveStateDir: (env: NodeJS.ProcessEnv) => string;
      };
      config: {
        current: () => OpenClawConfig;
      };
    };
    [key: string]: unknown;
  }

  export interface OpenClawPluginToolContext {
    agentAccountId?: string;
    messageChannel?: string;
    requesterSenderId?: string;
    config?: OpenClawConfig;
    getRuntimeConfig?: () => OpenClawConfig;
    runtimeConfig?: OpenClawConfig;
    [key: string]: unknown;
  }

  export interface AnyAgentTool {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<unknown>;
  }
}

declare module "openclaw/plugin-sdk/core" {
  export type {
    AnyAgentTool,
    OpenClawPluginApi,
    OpenClawPluginToolContext,
  } from "openclaw/plugin-sdk/channel-core";
}

declare module "openclaw/plugin-sdk/channel-actions" {
  export function createActionGate(
    actions: Record<string, boolean> | undefined,
  ): (name: string, defaultValue: boolean) => boolean;
  export function stringEnum<T extends readonly string[]>(
    values: T,
    options?: { description?: string },
  ): unknown;
}

declare module "openclaw/plugin-sdk/tool-results" {
  export function jsonResult(value: unknown): unknown;
}

declare module "openclaw/plugin-sdk/state-paths" {
  export function resolveStateDir(env?: NodeJS.ProcessEnv): string;
}

declare module "openclaw/plugin-sdk/channel-entry-contract" {
  export function defineBundledChannelEntry(options: Record<string, unknown>): unknown;
  export function defineBundledChannelSetupEntry(options: Record<string, unknown>): unknown;
}

/**
 * SDK-INTEGRATION-GUESS: the real shared inbound event lifecycle
 * (`docs/plugins/sdk-channel-plugins/durable-ingress.md`: "ingest, resolve,
 * record, dispatch, finalize"). `runChannelInboundEvent<TRaw,
 * TDispatchResult>(...)` is the export name grep turned up in
 * `src/plugin-sdk/channel-inbound.ts`; its real parameter contract
 * (`ChannelInboundEventRunnerParams`) is built from a chain of
 * classify/build-context/plan/dispatch helper types this plugin has not
 * traced end to end. The signature below is a deliberately loose,
 * unverified placeholder -- see HANDOFF.md's open questions before relying
 * on this call in production.
 */
declare module "openclaw/plugin-sdk/channel-inbound" {
  export function runChannelInboundEvent<TRaw = unknown, TDispatchResult = unknown>(
    params: {
      channelId: string;
      accountId?: string | null;
      raw: TRaw;
      chatId: string;
      senderId: string;
      text: string;
      isGroup: boolean;
      mentionsSelf: boolean;
    },
  ): Promise<TDispatchResult>;
}
