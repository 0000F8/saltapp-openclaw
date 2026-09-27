import { describe, expect, it, vi } from "vitest";
import { runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import {
  createChatOpenedHandler,
  createMessageHandler,
  inspectAccount,
  resolveAccount,
  saltChannelPlugin,
  sendChannelText,
} from "./channel.js";
import type { MessageContext, ChatOpenedContext } from "salt-agent-sdk";

// `openclaw` is not resolvable in this standalone repo (see
// src/types/openclaw-plugin-sdk.d.ts's header comment), so both subpaths
// channel.ts imports at the VALUE level (not `import type`) are mocked
// with minimal stand-ins matching this plugin's own ambient types --
// good enough to exercise this plugin's own logic, not a substitute for
// running inside a real OpenClaw host. `salt-agent-sdk` itself is left
// mostly real (createSaltClient, sameId, FileCursorStore/FileDedupeStore
// are plain, side-effect-free exports, and none of these tests invoke
// startSaltChannel, which is the only thing that opens a real socket) --
// only `encryptFor` is stubbed, the same way outbound.test.ts stubs it,
// since createReplySender (used by sendChannelText's encrypted branch)
// imports it directly rather than accepting it injected, and the fake
// public keys these tests use aren't valid PGP armor. See HANDOFF.md.
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
vi.mock("salt-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("salt-agent-sdk")>();
  return {
    ...actual,
    encryptFor: vi.fn(async (_plaintext: string, keys: string[]) => `cipher(${keys.join(",")})`),
  };
});

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
  it("resolves every field from channels.salt, with defaults for the optional ones", () => {
    const account = resolveAccount(FULL_CONFIG);
    expect(account).toMatchObject({
      host: "https://saltapp.ai",
      agentId: "agent-self",
      apiKey: "key-1",
      privateKey: "priv",
      publicKey: "pub",
      passphrase: "pass",
      handle: undefined,
      pollLimit: 100,
      verifySignatures: true,
      joinCommons: false,
      interests: undefined,
    });
  });

  it("throws naming the first missing required field", () => {
    const cfg = { channels: { salt: { host: "https://saltapp.ai" } } } as any;
    expect(() => resolveAccount(cfg)).toThrow(/agentId is required/);
  });

  it("resolves handle, pollLimit, verifySignatures, joinCommons, and interests when set", () => {
    const cfg = {
      channels: {
        salt: {
          ...FULL_CONFIG.channels.salt,
          handle: "salt_bot",
          pollLimit: 25,
          verifySignatures: false,
          joinCommons: true,
          interests: { mode: "keywords", keywords: ["help", "urgent"] },
        },
      },
    } as any;
    const account = resolveAccount(cfg);
    expect(account.handle).toBe("salt_bot");
    expect(account.pollLimit).toBe(25);
    expect(account.verifySignatures).toBe(false);
    expect(account.joinCommons).toBe(true);
    expect(account.interests).toEqual({ mode: "keywords", keywords: ["help", "urgent"] });
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
    expect(typeof (saltChannelPlugin as any).outbound.attachedResults.sendText).toBe("function");
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

  it("sendText refuses before the channel has started", async () => {
    const sendText = (saltChannelPlugin as any).outbound.attachedResults.sendText;
    await expect(sendText({ to: "chat-1", text: "hi" })).rejects.toThrow(/before the channel finished starting/);
  });
});

const account = {
  host: "https://saltapp.ai",
  agentId: "agent-self",
  apiKey: "key-1",
  privateKey: "priv",
  publicKey: "pub",
  passphrase: "pass",
  handle: "salt_bot",
  pollLimit: 100,
  verifySignatures: true,
  joinCommons: false,
  interests: undefined,
};

function makeDeps(members: Array<{ id: string; account_type?: string; public_key?: string }>) {
  const client = {
    getChatMembers: vi.fn().mockResolvedValue(members),
    signalTyping: vi.fn().mockResolvedValue(undefined),
    setChatSubscription: vi.fn().mockResolvedValue(undefined),
    postPlainMessage: vi.fn().mockResolvedValue({ id: "plain-1" }),
    postMessage: vi.fn().mockResolvedValue({ id: "cipher-1" }),
  };
  return {
    client: client as any,
    restOptions: { host: account.host, apiKey: account.apiKey },
    identity: { saltAppId: account.agentId, username: account.handle, apiKey: account.apiKey, publicKey: account.publicKey, privateKey: account.privateKey },
    account,
    logger: { info: vi.fn(), error: vi.fn() },
  };
}

function makeCtx(overrides: Partial<MessageContext> & { chatId: string; senderId: string; text: string }): MessageContext {
  return {
    identity: undefined,
    chatId: overrides.chatId,
    senderId: overrides.senderId,
    sender: { id: overrides.senderId, account_type: "User" },
    text: overrides.text,
    encrypted: true,
    delegationDepth: 0,
    chatMeta: undefined,
    roomId: overrides.chatId,
    session: undefined,
    reply: vi.fn(),
    ask: vi.fn(),
    approve: vi.fn(),
    ...overrides,
  } as unknown as MessageContext;
}

const runChannelInboundEventMock = runChannelInboundEvent as unknown as ReturnType<typeof vi.fn>;

describe("createMessageHandler", () => {
  it("ignores a group message that does not mention this agent's handle, before signalling typing or dispatching", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }, { id: "human-2" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createMessageHandler(deps as any);
    const ctx = makeCtx({ chatId: "chat-1", senderId: "human-1", text: "hey what's up" });

    await handler(ctx);

    expect(deps.client.signalTyping).not.toHaveBeenCalled();
    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
  });

  it("answers a group message that DOES mention this agent's handle", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }, { id: "human-2" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createMessageHandler(deps as any);
    const ctx = makeCtx({ chatId: "chat-1", senderId: "human-1", text: "hey @salt_bot can you help" });

    await handler(ctx);

    expect(deps.client.signalTyping).toHaveBeenCalledWith(account.apiKey, "chat-1");
    expect(runChannelInboundEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "salt",
        chatId: "chat-1",
        senderId: "human-1",
        text: "hey @salt_bot can you help",
        isGroup: true,
        mentionsSelf: true,
      }),
    );
  });

  it("always answers a DM regardless of mentions", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createMessageHandler(deps as any);
    const ctx = makeCtx({ chatId: "chat-1", senderId: "human-1", text: "no mention here" });

    await handler(ctx);

    expect(runChannelInboundEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ isGroup: false, mentionsSelf: false }),
    );
  });

  it("never answers a group message when no handle is configured, and logs why (once)", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }, { id: "human-2" }]);
    deps.account = { ...account, handle: undefined };
    runChannelInboundEventMock.mockClear();
    const handler = createMessageHandler(deps as any);

    await handler(makeCtx({ chatId: "chat-1", senderId: "human-1", text: "@salt_bot hello" }));
    await handler(makeCtx({ chatId: "chat-1", senderId: "human-1", text: "@salt_bot hello again" }));

    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledTimes(1); // warns once, not on every message
  });

  it("exposes encrypted and deliveredBecause on the raw payload for an open-room delivery", async () => {
    const deps = makeDeps([{ id: "agent-self" }, { id: "human-1" }]);
    runChannelInboundEventMock.mockClear();
    const handler = createMessageHandler(deps as any);
    const ctx = makeCtx({
      chatId: "chat-1",
      senderId: "human-1",
      text: "plain room text",
      encrypted: false,
      deliveredBecause: "keyword" as any,
    });

    await handler(ctx);

    expect(runChannelInboundEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: expect.objectContaining({ encrypted: false, deliveredBecause: "keyword" }),
      }),
    );
  });
});

describe("createChatOpenedHandler", () => {
  it("does nothing when no interests are configured", async () => {
    const deps = makeDeps([]);
    const handler = createChatOpenedHandler(deps as any);
    await handler({ chatId: "chat-1", chat: { encrypted: false } } as unknown as ChatOpenedContext);
    expect(deps.client.setChatSubscription).not.toHaveBeenCalled();
  });

  it("does nothing for an ordinary encrypted chat even with interests configured", async () => {
    const deps = makeDeps([]);
    deps.account = { ...account, interests: { mode: "all" } };
    const handler = createChatOpenedHandler(deps as any);
    await handler({ chatId: "chat-1", chat: {} } as unknown as ChatOpenedContext);
    expect(deps.client.setChatSubscription).not.toHaveBeenCalled();
  });

  it("applies configured interests to a newly-opened open room", async () => {
    const deps = makeDeps([]);
    deps.account = { ...account, interests: { mode: "keywords", keywords: ["help"] } };
    const handler = createChatOpenedHandler(deps as any);
    await handler({ chatId: "chat-1", chat: { encrypted: false } } as unknown as ChatOpenedContext);
    expect(deps.client.setChatSubscription).toHaveBeenCalledWith(account.apiKey, "chat-1", { mode: "keywords", keywords: ["help"] });
  });
});

describe("sendChannelText", () => {
  it("posts plain text into an open room without encrypting", async () => {
    const deps = makeDeps([{ id: "agent-self", public_key: "pub-self" }, { id: "human-1", public_key: "pub-human-1" }]);
    // Real GET /api/v1/chats/:id shape: `encrypted` lives under `session`,
    // never at the top level (see rest.test.ts). This fixture used to put
    // it at the top level, which matched -- and hid -- isOpenRoom's bug:
    // it always compared `undefined === false` and the plain-text branch
    // below was never actually reachable in production.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session: { id: "chat-1", encrypted: false } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    deps.restOptions = { ...deps.restOptions, fetchImpl } as any;

    const result = await sendChannelText(deps as any, { to: "chat-1", text: "hello room" });

    expect(deps.client.postPlainMessage).toHaveBeenCalledWith(account.apiKey, "chat-1", "hello room");
    expect(deps.client.postMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ messageId: "plain-1" });
  });

  it("encrypts for a chat that is not an open room", async () => {
    const deps = makeDeps([{ id: "agent-self", public_key: "pub-self" }, { id: "human-1", public_key: "pub-human-1" }]);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session: { id: "chat-1" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    deps.restOptions = { ...deps.restOptions, fetchImpl } as any;

    const result = await sendChannelText(deps as any, { to: "chat-1", text: "hello room" });

    expect(deps.client.postPlainMessage).not.toHaveBeenCalled();
    expect(deps.client.postMessage).toHaveBeenCalled();
    expect(result).toEqual({ messageId: "cipher-1" });
  });

  it("fails closed (encrypts) when the open-room lookup itself errors", async () => {
    const deps = makeDeps([{ id: "agent-self", public_key: "pub-self" }, { id: "human-1", public_key: "pub-human-1" }]);
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    deps.restOptions = { ...deps.restOptions, fetchImpl } as any;

    await sendChannelText(deps as any, { to: "chat-1", text: "hello room" });

    expect(deps.client.postPlainMessage).not.toHaveBeenCalled();
    expect(deps.client.postMessage).toHaveBeenCalled();
  });
});
