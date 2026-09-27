# AGENTS.md

Notes for an agent (or human) working in this repo.

## What this is

Salt (saltapp.ai) is an end-to-end encrypted chat where humans and AI
agents are equal contacts. This repo is an OpenClaw channel plugin
connecting an OpenClaw agent to Salt over Salt's socket-mode contract (a
live `createSocketClient` connection, not a webhook), because OpenClaw
usually runs somewhere with no public URL. Standalone repo, own git history,
not part of the Salt monorepo workspace (see `~/projects/salt/CLAUDE.md` for
that workspace's conventions -- this repo follows its own, listed below,
and is not itself one of that file's subprojects).

## Commands

```bash
npm install ../salt-agent-sdk --no-save   # run this FIRST -- see below, a
                                           # bare `npm install` fails outright
npm test          # vitest run -- the whole suite, one invocation
npx vitest run src/salt/rest.test.ts       # a single file
npm run build     # tsc -p tsconfig.json -> dist/
npx tsc -p tsconfig.json --noEmit          # type-check only
```

Verified 2026-09-27: a bare `npm install` fails outright (`ETARGET`, no
`node_modules` at all) because `package.json` depends on
`salt-agent-sdk@^0.10.0` and the public npm registry only has `0.1.0` --
`salt-agent-sdk`'s published version lags far behind this workspace's local
checkout (0.12.2 as of this pass; salt-agent-sdk itself is not published to
npm past 0.1.0 yet either). Run `npm install ../salt-agent-sdk --no-save`
FIRST and skip the bare `npm install` entirely -- it both links the local
sibling checkout and installs every other dependency in one pass (confirmed:
"added 45 packages"). `npm test` (61/61), `npm run build`, and
`npx tsc -p tsconfig.json --noEmit` all run clean afterward. The single-file
example above used to name `src/salt/envelope.test.ts`, which no longer
exists (see Architecture) -- updated to an existing file.

`package-lock.json` is gitignored on purpose: a local install's lockfile
records `salt-agent-sdk`'s `node_modules` entry as `{"resolved":
"../salt-agent-sdk", "link": true}`, a path that only exists on a machine
with that sibling checkout. Regenerate it locally with the `npm install
../salt-agent-sdk --no-save` command above; commit it once `salt-agent-sdk`
is actually published to the public npm registry past 0.1.0. This plugin
itself (`saltapp-openclaw`) is ALSO not published anywhere yet -- not to
npm, not to ClawHub -- see HANDOFF.md's "ClawHub publish steps" for what
that will take.

## Architecture

- ~~`src/salt/envelope.ts`~~ / ~~`src/salt/socket-poller.ts`~~ -- **deleted**
  in the 2026-09-22 "open rooms, no more polling" pass (owner: "DO NOT USE
  POLLING as a mechanic EVER"). These used to be this plugin's own
  hand-rolled HMAC envelope verifier and short-poll loop; both jobs now
  belong to salt-agent-sdk's `createSocketClient` (a real Action Cable
  websocket, opened once in `src/channel.ts`'s `startSaltChannel` and held
  for the life of the process -- an idle, caught-up agent makes zero
  requests). Don't go looking for these files or re-add polling; see
  HANDOFF.md's 2026-09-22 entry and `channel.ts`'s own header comment.
- `src/salt/rest.ts` -- small REST helpers for salt-api endpoints
  salt-agent-sdk 0.10.0 doesn't wrap yet: a plain (non-invoice) payment
  request (`POST /api/v1/transfer_requests`), reactions, reading a chat's
  `encrypted` flag for open-room detection (`isOpenRoom`/`getChat`, since
  neither the SDK's `getChatMembers` nor this plugin's old REST client read
  that flag -- **see "Rules that bite" below: this is currently reading the
  wrong shape**), and the Commons (`getPublicConfig` for
  `GET /api/v1/config`'s `commons_chat_id`, `joinPublicChat` --
  **API-CONTRACT-GUESS**, its route was inferred rather than confirmed
  against a live salt-api at write time, see HANDOFF.md). The socket-mode
  contract itself and the delivery-mode switch used to live here too; both
  are now salt-agent-sdk's job (`createSocketClient`, `client.setDeliveryMode`).
  Everything else (`postMessage`, `postCard`/`updateCard`, `signalTyping`,
  wallets, ...) goes through `salt-agent-sdk`'s `createSaltClient` directly
  -- see `src/channel.ts`.
- `src/salt/inbound-mapper.ts` -- DM-vs-group classification (`classifyChat`
  -- inline members, fetched members, and the name/public-fallback
  heuristic) and this plugin's own group-mention etiquette check
  (`mentionsSelfByHandle`, a plaintext "@handle" substring heuristic -- see
  HANDOFF.md for why it's a heuristic now, not an exact id check). Pure and
  async-only where `classifyChat` needs the injected `fetchMembers`
  fallback; no crypto, no network calls of its own. Used to also map a raw,
  still-encrypted webhook/update body into an inbound shape
  (`mapMessageEventToInbound` / `SaltInboundMessage`) -- both gone now that
  `createSocketClient` hands `channel.ts`'s `onMessage` a decrypted
  `MessageContext` directly.
- `src/salt/cursor-store.ts` -- resolves this plugin's per-account state
  DIRECTORY under OpenClaw's plugin state dir (`resolveSaltCursorDir`) and
  points salt-agent-sdk's own `FileCursorStore`/`FileDedupeStore` at it, so
  a restart still resumes instead of replaying the retained outbox. Used to
  also do the actual cursor read/write itself (a hand-rolled JSON file)
  back when this plugin hand-rolled its own poll loop; that responsibility
  moved to the SDK's own file-backed stores. NOT SQLite, on purpose:
  `openKeyedStore` / `openSyncKeyedStore` / `openBlobStore` are refused to
  anything but bundled or trusted-official plugins (see
  `docs/plugins/sdk-runtime/state-and-system.md` in the OpenClaw repo),
  which this plugin is not (yet). See HANDOFF.md.
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
  plus the runtime wiring `registerFull` calls: opens the single
  `createSocketClient` websocket connection for the life of the process
  (`startSaltChannel`), registers the two Salt-specific tools, joins the
  Commons at startup when configured (`joinCommons`) and applies this
  agent's configured `interests` to any open room it's later added to
  (`createChatOpenedHandler`). Every `SDK-INTEGRATION-GUESS` comment marks a
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
(`encryptFor`/`createSaltClient`/`createSocketClient`) and handles only the
DM/group/mentions mapping itself (`classifyChat`, `mentionsSelfByHandle` in
`inbound-mapper.ts`) -- signature verification and decrypt are
`createSocketClient`'s job now, not this plugin's -- deliberately leaving
"should I reply" to OpenClaw's own turn pipeline once the message reaches it.

## Testing conventions

- Vitest, colocated `*.test.ts` beside the module it tests (matches both
  OpenClaw's own bundled-plugin convention and the doc's own example).
- Mock REST via a plain `fetchImpl` injection (`src/salt/rest.ts`'s
  `SaltRestOptions.fetchImpl`) or by passing hand-built dep objects
  (`src/salt/outbound.ts`) -- never reach into `node_modules` internals or
  spin up a real HTTP server.
- `src/channel.test.ts` mocks the two `openclaw/plugin-sdk/*` subpaths this
  repo's own value-level imports touch (`channel-core`, `channel-inbound`)
  plus `salt-agent-sdk` itself, with minimal stand-ins, since neither
  `openclaw` nor a real socket connection is available outside a real
  OpenClaw checkout / live salt-api. This proves this plugin's OWN logic,
  not real OpenClaw runtime behavior -- see HANDOFF.md before treating a
  green test suite as proof this loads inside a real Gateway.
- **Retired**: earlier passes had a trap where a test that hardcoded a
  signed envelope's `t=` timestamp went stale the moment the default 300s
  tolerance window passed real wall-clock time (`envelope.test.ts` /
  `socket-poller.test.ts`, both deleted in the 2026-09-22 open-rooms pass --
  signature verification and the poll loop are `createSocketClient`'s job
  now). Keep this in mind only if local envelope/HMAC verification is ever
  reintroduced here.

## Rules that bite

Cross-repo facts about Salt's socket-mode contract that are easy to get
wrong from inside a plugin like this one:

- A tool waiting for a human's answer to a card must poll/wait on its OWN
  card via `GET /api/v1/cards/:id` -- **never** `GET /api/v1/agent/updates`
  (or, here, the equivalent `createSocketClient`/`AgentUpdatesChannel`
  outbox): that stream has exactly ONE forward-only cursor per agent, and
  consuming from it to wait for a card answer would silently advance the
  same cursor `channel.ts`'s `startSaltChannel` depends on for ordinary
  messages, cutting off its own backlog. This plugin does not yet implement
  waiting on a card's answer (see HANDOFF.md's "Left undone" --
  `card_interaction` events aren't wired into OpenClaw's turn pipeline at
  all yet); whoever adds it must read the card directly, not the outbox.
- `POST /api/v1/cards` responds referencing the chat MESSAGE it created --
  `message_id`/`resource_id` -- never a top-level `id`. `tools.ts`'s
  `salt_post_card` currently passes `deps.postCard`'s result straight
  through untouched (typed `unknown`), so this isn't a live bug here yet,
  but don't assume `.id` on that result if you start parsing it.
- **A chat's `encrypted` flag lives nested under `session`, not top-level**
  -- and `src/salt/rest.ts`'s `SaltChatInfo`/`getChat`/`isOpenRoom`
  currently read/type it at the TOP level (`chat.encrypted === false`).
  Verified 2026-09-27: this means `isOpenRoom` reads a field salt-api never
  puts there and will always evaluate `undefined === false`, i.e. always
  `false` -- an actual open room is misdetected as still-encrypted every
  time, so `channel.ts`'s `sendText` will PGP-encrypt a reply into what
  should have been a plain-text open room. `rest.test.ts`'s own fakes mock
  `{ id, encrypted: false }` at the top level too, which is exactly why
  `npm test` stays green despite this -- see the next bullet. **This is a
  known, unfixed bug as of this pass; flagged here rather than fixed
  because it's outside AGENTS.md's own scope for this pass.**
- Since salt-api 0.98.1, an encrypted chat refuses a non-PGP-armored
  message body -- keep this in mind in `outbound.ts`/`sendText`'s
  plain-vs-encrypted branch, especially once the `isOpenRoom` bug above is
  fixed and that branch starts actually taking the plain path sometimes.
- **Test fakes must model salt-api's ACTUAL controller response shape, not
  the calling code's assumption** -- this exact bug (mocking the wrong
  nesting level for a field) has shipped identically in five downstream
  adapters, and this repo's own `rest.test.ts` is a live instance of it
  today (see the `encrypted`-flag bullet above). When adding or reviewing a
  REST fake, check the field's real position in salt-api's serializer, not
  just what makes the calling code's test pass.

## Where the truth is

- Salt's OpenAPI spec: https://saltapp.ai/api/openapi.json
- Salt's own agent-facing doc: https://saltapp.ai/agents.md
- Salt's hosted MCP server (a second way an agent can reach Salt -- not what
  this plugin uses, which is the socket-mode contract directly):
  https://mcp.saltapp.ai/mcp
- `docs/CLIENTS.md` in the sibling `salt-mcp` repo
  (`~/projects/salt/salt-mcp/docs/CLIENTS.md`) -- client-integration notes
  from the other side of the same protocol.
- `README.md` (this repo) -- setup/config for a human installing this
  plugin. `HANDOFF.md` (this repo) -- what shipped, what's still guessed at
  against the real OpenClaw plugin SDK, and ClawHub publish steps.

## Conventions carried over from the Salt monorepo

- Any Salt account created by tooling/tests is named `SALT-…` with a
  `salt-…@example.test` address -- not applicable to THIS repo's own tests
  (they never touch a real salt-api), but keep it in mind if you add a
  live-integration test later.
- No third-party analytics/error-tracking SDKs.
- Public-facing copy says "humans and AI agents," never "people" (see
  `README.md`, `SKILL.md`).
