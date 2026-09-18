import { describe, expect, it, vi } from "vitest";
import { runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import { createUpdateHandler, inspectAccount, resolveAccount, saltChannelPlugin } from "./channel.js";
import type { VerifiedUpdate } from "./salt/socket-poller.js";

// `openclaw` is not resolvable in this standalone repo (see
// src/types/openclaw-plugin-sdk.d.ts's header comment), so both subpaths
// channel.ts imports at the VALUE level (not `import type`) are mocked
// with minimal stand-ins matching this plugin's own ambient types --
// good enough to exercise this plugin's own logic, not a substitute for
// running inside a real OpenClaw host. See HANDOFF.md.
vi.mock("openclaw/plugin-sdk/channel-core", () => ({
  createChannelPluginBase: (base: unknown) => base,
  createChatChannelPlugin: (opts: any) => ({
    ...(opts.base as object),
    security: opts.security,
    threading: opts.threading,
    outbound: opts.outbound,
  }),
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  runChannelInboundEvent: vi.fn().mockResolvedValue(undefined),
}));

const FULL_CONFIG = {
  channels: {
    salt: {
      host: "https://saltapp.ai",
      agentId: "agent-self",
      apiKey: "key-1",
      privateKey: "priv",
      publicKey: "pub",
      passphrase: "pass",
    },
  },
} as any;

describe("resolveAccount", () => {
  it("resolves every field from channels.salt", () => {
    const account = resolveAccount(FULL_CONFIG);
    expect(account).toMatchObject({
      host: "https://saltapp.ai",
      agentId: "agent-self",
      apiKey: "key-1",
      privateKey: "priv",
      publicKey: "pub",
      passphrase: "pass",
      pollTimeoutSeconds: 25,
      pollLimit: 50,
      verifySignatures: true,
    });
  });

  it("throws naming the first missing required field", () => {
    const cfg = { channels: { salt: { host: "https://saltapp.ai" } } } as any;
    expect(() => resolveAccount(cfg)).toThrow(/agentId is required/);
  });

  it("respects explicit poll tuning and verifySignatures: false", () => {
    const cfg = {
      channels: { salt: { ...FULL_CONFIG.channels.salt, pollTimeoutSeconds: 10, pollLimit: 5, verifySignatures: false } },
    } as any;
    const account = resolveAccount(cfg);
    expect(account.pollTimeoutSeconds).toBe(10);
    expect(account.pollLimit).toBe(5);
    expect(account.verifySignatures).toBe(false);
  });
});

describe("inspectAccount", () => {
  it("reports configured: true and available secret statuses when everything is present", () => {
    const result = inspectAccount(FULL_CONFIG);
    expect(result).toEqual({
      enabled: true,
      configured: true,
      apiKeyStatus: "available",
      privateKeyStatus: "available",
    });
  });

  it("reports configured: false and missing statuses when secrets are absent", () => {
    const cfg = { channels: { salt: { host: "https://saltapp.ai" } } } as any;
    const result = inspectAccount(cfg);
    expect(result).toEqual({
      enabled: true,
      configured: false,
      apiKeyStatus: "missing",
      privateKeyStatus: "missing",
    });
  });

  it("reports enabled: false when there is no host at all", () => {
    const result = inspectAccount({ channels: {} } as any);
    expect(result.enabled).toBe(false);
    expect(result.configured).toBe(false);
  });
});

describe("saltChannelPlugin", () => {
  it("exposes the expected adapter surfaces", () => {
    expect(saltChannelPlugin.id).toBe("salt");
    expect(typeof saltChannelPlugin.config.resolveAccount).toBe("function");
    expect(typeof saltChannelPlugin.config.inspectAccount).toBe("function");
    expect(typeof saltChannelPlugin.setup.applyAccountConfig).toBe("function");
  });

  it("applyAccountConfig merges input into channels.salt without dropping other channels", () => {
    const cfg = { channels: { telegram: { token: "t" } } } as any;
    const next = saltChannelPlugin.setup.applyAccountConfig({
      cfg,
      input: { host: "https://saltapp.ai", apiKey: "key-1" },
    }) as any;
    expect(next.channels.telegram).toEqual({ token: "t" });
    expect(next.channels.salt).toEqual({ host: "https://saltapp.ai", apiKey: "key-1" });
  });
});

function makeUpdate(body: unknown, event = "message"): VerifiedUpdate {
  return { id: "1", event, body, rawBody: JSON.stringify(body), createdAt: "2026-09-18T00:00:00Z" };
}

const account = {
  host: "https://saltapp.ai",
  agentId: "agent-self",
  apiKey: "key-1",
  privateKey: "priv",
  publicKey: "pub",
  passphrase: "pass",
  pollTimeoutSeconds: 25,
  pollLimit: 50,
  verifySignatures: true,
};

function makeDeps(members: Array<{ id: string; account_type?: string }>) {
  const client = {
    getChatMembers: vi.fn().mockResolvedValue(members),
    signalTyping: vi.fn().mockResolvedValue(undefined),
  };
  return {
    client: client as any,
    restOptions: { host: account.host, apiKey: account.apiKey },
    account,
    logger: { info: vi.fn(), error: vi.fn() },
    decrypt: vi.fn().mockResolvedValue("decrypted plaintext"),
  };
}

const runChannelInboundEventMock = runChannelInboundEvent as unknown as ReturnType<typeof vi.fn>;

describe("createUpdateHandler", () => {
  it("ignores non-message events without decrypting or dispatching", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createUpdateHandler(deps as any, {} as any);

    await handler(makeUpdate({}, "card_interaction"));

    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("card_interaction"));
    expect(deps.decrypt).not.toHaveBeenCalled();
    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
  });

  it("ignores a group message that does not mention this agent, before signalling typing or dispatching", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }, { id: "human-2" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createUpdateHandler(deps as any, {} as any);
    const body = {
      message: {
        chat_id: "chat-1",
        message: "-----BEGIN PGP MESSAGE-----",
        user: { id: "human-1", account_type: "User" },
        mentions: [],
      },
    };

    await handler(makeUpdate(body));

    expect(deps.decrypt).toHaveBeenCalled(); // decryption happens before gating
    expect(deps.client.signalTyping).not.toHaveBeenCalled();
    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
  });

  it("answers a group message that DOES mention this agent", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }, { id: "human-2" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createUpdateHandler(deps as any, {} as any);
    const body = {
      message: {
        chat_id: "chat-1",
        message: "-----BEGIN PGP MESSAGE-----",
        user: { id: "human-1", account_type: "User" },
        mentions: ["agent-self"],
      },
    };

    await handler(makeUpdate(body));

    expect(deps.client.signalTyping).toHaveBeenCalledWith(account.apiKey, "chat-1");
    expect(runChannelInboundEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "salt",
        chatId: "chat-1",
        senderId: "human-1",
        text: "decrypted plaintext",
        isGroup: true,
        mentionsSelf: true,
      }),
    );
  });

  it("always answers a DM regardless of mentions", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createUpdateHandler(deps as any, {} as any);
    const body = {
      message: {
        chat_id: "chat-1",
        message: "-----BEGIN PGP MESSAGE-----",
        user: { id: "human-1", account_type: "User" },
        mentions: [],
      },
    };

    await handler(makeUpdate(body));

    expect(runChannelInboundEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ isGroup: false, mentionsSelf: false }),
    );
  });

  it("ignores this agent's own echoed message (never replies to itself)", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createUpdateHandler(deps as any, {} as any);
    const body = {
      message: {
        chat_id: "chat-1",
        message: "-----BEGIN PGP MESSAGE-----",
        user: { id: "agent-self", account_type: "Agent" },
        mentions: [],
      },
    };

    await handler(makeUpdate(body));

    expect(deps.client.signalTyping).not.toHaveBeenCalled();
    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
  });

  it("ignores a row with no message ciphertext (e.g. a system-event-shaped body)", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createUpdateHandler(deps as any, {} as any);

    await handler(makeUpdate({ message: { chat_id: "chat-1", event_type: "call_missed" } }));

    expect(deps.decrypt).not.toHaveBeenCalled();
    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
  });
});
