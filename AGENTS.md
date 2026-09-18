# AGENTS.md

Notes for an agent (or human) working in this repo.

## What this is

An OpenClaw channel plugin connecting to Salt (saltapp.ai) over Salt's
socket-mode long-poll contract instead of a webhook, because OpenClaw
usually runs somewhere with no public URL. Standalone repo, own git history,
not part of the Salt monorepo workspace (see `~/projects/salt/CLAUDE.md` for
that workspace's conventions -- this repo follows its own, listed below,
and is not itself one of that file's subprojects).

## Commands

```bash
npm install
npm install ../salt-agent-sdk --no-save   # local dev only -- salt-agent-sdk's
                                           # public npm version (0.1.0) lags
                                           # far behind the local repo's 0.7.1
npm test          # vitest run -- the whole suite, one invocation
npx vitest run src/salt/envelope.test.ts   # a single file
npm run build     # tsc -p tsconfig.json -> dist/
npx tsc -p tsconfig.json --noEmit          # type-check only
```

`package-lock.json` is gitignored on purpose: a local install's lockfile
records `salt-agent-sdk`'s `node_modules` entry as `{"resolved":
"../salt-agent-sdk", "link": true}`, a path that only exists on a machine
with that sibling checkout. Regenerate it locally with the two `npm
install` commands above; commit it once `salt-agent-sdk` 0.7.1+ is actually
published to the public npm registry (it currently sits at 0.1.0 there).

## Architecture

- `src/salt/envelope.ts` -- HMAC signature verification for one socket-mode
  update row (`{headers, body}`), mirroring salt-agent-sdk's
  `createWebhookServer` HMAC recipe (not exported there as a standalone
  function, so reimplemented here against the exact math: `X-Salt-Signature:
  t=<unix>,v1=<hex>`, `v1 = HMAC-SHA256(secret, "${t}.${rawBody}")`).
- `src/salt/rest.ts` -- small REST helpers for endpoints salt-agent-sdk
  0.7.1 doesn't wrap yet: the socket-mode contract itself
  (`GET /api/v1/agent/updates`, `PATCH /api/v1/agents/delivery`), a plain
  (non-invoice) payment request (`POST /api/v1/transfer_requests`), and
  reactions. Everything else (`postMessage`, `postCard`/`updateCard`,
  `signalTyping`, wallets, ...) goes through `salt-agent-sdk`'s
  `createSaltClient` directly -- see `src/channel.ts`.
- `src/salt/inbound-mapper.ts` -- maps a decrypted Salt `message` event body
  into `SaltInboundMessage` (DM vs group, sender, mentions, lane info). Pure
  and async-only where it needs a member-list fallback fetch; no crypto, no
  network calls of its own beyond the injected `fetchMembers`.
  `classifyChat` explains the DM/group heuristics and their fallback order.
- `src/salt/cursor-store.ts` -- plain JSON-file cursor persistence under
  OpenClaw's plugin state dir. NOT SQLite, on purpose: `openKeyedStore` /
  `openSyncKeyedStore` / `openBlobStore` are refused to anything but bundled
  or trusted-official plugins (see `docs/plugins/sdk-runtime/state-and-system.md`
  in the OpenClaw repo), which this plugin is not (yet). See HANDOFF.md.
- `src/salt/socket-poller.ts` -- the long-poll loop: fetch, verify each row,
  hand verified rows to a caller-supplied `onUpdate`, advance+persist the
  cursor. A row a handler throws on still advances the cursor -- there is no
  redelivery mechanism for a row already fetched.
- `src/salt/outbound.ts` -- encrypt-for-all-current-members + post. Built
  from the same two salt-agent-sdk primitives (`encryptFor`, `postMessage`)
  `createWebhookServer` uses internally, but does NOT reuse
  `createWebhookServer` itself -- see "Why not reuse
  salt-agent-sdk's webhook server" below.
- `src/salt/tools.ts` -- `salt_post_card` / `salt_request_payment`, following
  the `api.registerTool((context) => tool | null, {name})` pattern bundled
  channel plugins use for a platform-specific action beyond the shared
  `message` tool (see WhatsApp's `whatsapp_call` in the OpenClaw repo).
- `src/channel.ts` -- the `ChannelPlugin` object (`createChatChannelPlugin`)
  plus the runtime wiring `registerFull` calls: starts the socket bridge,
  registers the two tools. Every `SDK-INTEGRATION-GUESS` comment marks a
  spot where this plugin guesses at the real compiled OpenClaw SDK's
  contract instead of citing verified doc text or bundled-plugin source.
- `index.ts` / `setup-entry.ts` -- the two OpenClaw entry points
  (`defineChannelPluginEntry` / `defineSetupPluginEntry`), per
  `docs/plugins/sdk-channel-plugins.md`'s walkthrough.
- `src/types/openclaw-plugin-sdk.d.ts` -- hand-written stand-in types for
  the `openclaw/plugin-sdk/*` subpaths this plugin imports. Read its header
  comment before trusting any type surface it declares.

## Why not reuse salt-agent-sdk's webhook server wholesale

`createWebhookServer` bakes in a whole bot-loop model that's correct for a
standalone webhook agent (salt-claude-agent) but WRONG to also apply inside
an OpenClaw channel plugin: Global Agent Chat Mode gating, the Mediator's
observe-silently rule, agent-to-agent reply-loop capping, delegation-depth
tracking -- all decisions about "should THIS process reply right now,"
which for an OpenClaw agent are OpenClaw's own job (its session/turn model,
its own group mention gating, its own loop protection). Running both would
double-gate the same decision from two different rulebooks. So this plugin
takes only the protocol-level primitives it actually needs
(`decrypt`/`encryptFor`/`createSaltClient`) and reimplements just the
signature check and DM/group/mentions mapping itself, deliberately leaving
"should I reply" to OpenClaw's own turn pipeline once the message reaches it.

## Testing conventions

- Vitest, colocated `*.test.ts` beside the module it tests (matches both
  OpenClaw's own bundled-plugin convention and the doc's own example).
- Mock REST via a plain `fetchImpl` injection (`src/salt/rest.ts`'s
  `SaltRestOptions.fetchImpl`) or by passing hand-built dep objects
  (`src/salt/outbound.ts`, `src/salt/socket-poller.ts`) -- never reach into
  `node_modules` internals or spin up a real HTTP server.
- `src/channel.test.ts` mocks the two `openclaw/plugin-sdk/*` subpaths this
  repo's own value-level imports touch (`channel-core`, `channel-inbound`)
  with minimal stand-ins, since `openclaw` itself is not resolvable outside
  a real OpenClaw checkout. This proves this plugin's OWN logic, not real
  OpenClaw runtime behavior -- see HANDOFF.md before treating a green test
  suite as proof this loads inside a real Gateway.
- A test that hardcodes a signed envelope's `t=` timestamp will go stale the
  moment the default 300s tolerance window passes real wall-clock time --
  sign with `Math.floor(Date.now() / 1000)` (see `socket-poller.test.ts`),
  or inject `nowSeconds` directly (see `envelope.test.ts`).

## Conventions carried over from the Salt monorepo

- Any Salt account created by tooling/tests is named `SALT-…` with a
  `salt-…@example.test` address -- not applicable to THIS repo's own tests
  (they never touch a real salt-api), but keep it in mind if you add a
  live-integration test later.
- No third-party analytics/error-tracking SDKs.
- Public-facing copy says "humans and AI agents," never "people" (see
  `README.md`, `SKILL.md`).
