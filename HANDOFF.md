# HANDOFF.md

## 2026-09-22, later: open rooms, interests, and no more polling (salt-agent-sdk 0.10.1)

Owner rule, stated flat: "DO NOT USE POLLING as a mechanic EVER." Everything
below is a response to that plus salt-api's open-rooms/interests contract
(`encrypted: false` chats, plain text on the wire, `delivered_because` on a
delivery, `PUT/DELETE /api/v1/chats/:id/subscription`).

- **Receiving is now a real push connection, not a loop.** `src/salt/socket-poller.ts`
  and `src/salt/envelope.ts` (this plugin's own hand-rolled short-poll loop
  and HMAC envelope verifier) are both deleted. `channel.ts`'s
  `startSaltChannel` now opens exactly one `salt-agent-sdk`
  `createSocketClient` connection (a real Action Cable websocket) for the
  life of the process; envelope verification, decrypt-or-pass-through,
  identity resolution, cursor persistence and delivery-id dedupe are all
  the SDK's job now (its own `FileCursorStore`/`FileDedupeStore`, rooted at
  this plugin's existing OpenClaw-state-dir path via
  `cursor-store.ts#resolveSaltCursorDir`, so a restart still resumes
  instead of replaying the retained outbox). An idle, caught-up agent makes
  zero requests -- confirmed with `grep -rniE "setinterval|while \("` over
  `src/`: no hits outside comments/variable names.
- **`inbound-mapper.ts` lost its raw-body mapper.** `mapMessageEventToInbound`
  is gone (decrypt/routing is inside the SDK now, so there's no raw body
  left to map here) -- `classifyChat` (DM vs group) is kept as-is. New:
  `mentionsSelfByHandle(text, handle)`, a plaintext "@handle" substring
  check. **Real loss, not a nicety**: `salt-agent-sdk`'s `MessageContext`
  does not expose the raw `message.mentions` id array the way the old
  webhook/update body did (confirmed: not a field on `MessageContext`,
  `webhook.ts` read). This plugin's group @mention etiquette used to be an
  exact "is this agent's id in the mentions array" check; it is now a
  heuristic that can miss a mention a client attached without also writing
  "@handle" into the message body, and can rarely false-positive on a
  message that merely quotes "@handle." A new `handle` config field feeds
  it (`openclaw.plugin.json`); with no `handle` configured, group messages
  are never answered (logged once, not per-message) -- a DM is unaffected.
  If `salt-agent-sdk` ever surfaces the real mentions array on
  `MessageContext`, switch back to an exact check.
- **Open rooms.** `ctx.encrypted === false` (from the SDK) is threaded
  straight through to OpenClaw's inbound event as `raw.encrypted`, no
  decrypt attempted either way (the SDK already didn't attempt one).
  Outbound: `rest.ts#isOpenRoom` (a small `GET /api/v1/chats/:id` helper,
  since neither the SDK's `getChatMembers` nor this plugin's old REST
  client read the chat-level `encrypted` flag) gates a plain
  `client.postPlainMessage` vs. an encrypted `createReplySender` call --
  wired into the one real outbound call site that existed,
  `outbound.attachedResults.sendText` (previously a hard stub that threw
  unconditionally, "not wired yet," for BOTH encrypted and plain chats --
  see the 2026-09-18 entry below; fixed here via a module-scoped mutable
  `runtimeRef` since `sendText`'s closure is built before `startSaltChannel`
  ever runs and has no way to receive deps as an argument). `isOpenRoom`
  fails CLOSED (an unreadable lookup is treated as "still encrypted")
  rather than risk a plaintext leak into a real E2E chat on an error.
- **`deliveredBecause` -- a live cross-lane staleness gotcha, RESOLVED same day.** `MessageContext.deliveredBecause`
  landed in `salt-agent-sdk` `src/webhook.ts` (0.10.1, merged same day by
  the sibling `sdk-cable` lane) but this plugin's `node_modules/salt-agent-sdk`
  symlink's `dist/` (both the `.d.ts` AND the compiled `.js` -- checked
  both) still predated that commit when this entry was first written, so
  depending on the typed field failed this plugin's build, and would have
  read `undefined` at runtime too even if the type check were bypassed. Read
  via a loose cast at first (so this plugin's build didn't hard-depend on
  the sibling repo's build-artifact timing), deliberately not fixed by
  running a build in `../salt-agent-sdk` from here -- that repo was a
  different lane's working tree in this session, not this task's call to
  touch. The sibling lane rebuilt its `dist/` shortly after (confirmed via
  `grep deliveredBecause dist/webhook.js` and the file's mtime moving past
  `src/webhook.ts`'s), and `team-lead` flagged the same thing -- switched
  `channel.ts`'s `raw.deliveredBecause` from the loose cast to the real
  typed `ctx.deliveredBecause` in a follow-up commit once confirmed. Both
  `tsc -p tsconfig.json` and `npx vitest run` (61/61) stayed clean across
  the switch.
- **Interests + the Commons.** New config: `interests: {mode, keywords?}`
  and `joinCommons: boolean`. `startSaltChannel` joins the Commons at
  startup when `joinCommons` is set (`rest.ts#getPublicConfig` for
  `commons_chat_id`, `rest.ts#joinPublicChat`, then
  `client.setChatSubscription`), and a new `onChatOpened` handler
  (`createChatOpenedHandler`) applies the same `interests` automatically
  whenever this agent is added to any OTHER open room later, not just the
  Commons. **API-CONTRACT-GUESS**: `joinPublicChat`'s route
  (`POST /api/v1/chats/:id/join_public`) is inferred from this task's own
  wording ("joins via join_public") and salt-api's existing action-route
  convention (`/sidechain`, `/typing`, `/hide`, `/lock`) -- salt-api's
  actual Commons routes were still in flight on a sibling lane
  (`open-rooms-api`) at write time and not available in this checkout
  (`salt-api` here sat at 0.80.1, one release behind the 0.81.0 contract
  this task cited) to confirm against. Verify this path once that lane
  ships and update `rest.ts#joinPublicChat`'s doc comment.
- **`pollTimeoutSeconds` config field removed** (no longer meaningful --
  there is no poll timeout any more); `pollLimit` stays but now means the
  socket client's backfill page size, documented as such in
  `openclaw.plugin.json`.
- 61 tests passing (was 76 before this pass -- net fewer tests because the
  poll-loop and envelope-verification suites, ~30 tests total, are gone
  along with the code they tested; this pass also added ~15 new tests for
  the mention heuristic, open-room detection, interests, and the Commons),
  `tsc -p tsconfig.json` and `npm run build` both clean.
- **Left alone / out of scope for this pass**: `salt-mcp`'s missing
  `GET /api/v1/cards/:id` and the AgentKit provider's "one poller per
  agent" constraint (both called out by this task's own brief as belonging
  to a different repo/lane, not this one).

---

## 2026-09-22 alignment pass (salt-agent-sdk 0.8, round-4 socket contract)

- `SALT_POLL_TIMEOUT_SECONDS` default (and `channel.ts`'s `pollTimeoutSeconds`
  default) dropped from 25 to 2 -- salt-api's `GET /api/v1/agent/updates`
  clamps `timeout` server-side to 0..2s now (H1's short-poll revision); 25
  was a pre-round-4 long-poll assumption.
- `socket-poller.ts`'s `pollOnce` now omits the `after` query param entirely
  on a fresh/lost cursor (was sending `after=0`), so salt-api's own
  server-side ack (`users.agent_updates_acked_id`) applies instead.
- `createSocketPoller`'s run loop is now adaptively paced
  (`activeDelayMs`/`idleDelayMs`, defaulting to salt-agent-sdk's own
  `ACTIVE_POLL_DELAY_MS`/`IDLE_POLL_DELAY_MS`, ~1s/~5s) instead of relying
  on the old 25s long-poll itself to provide pacing.
- Fixed README's agent-registration example: it was passing `private_key`
  to `client.createAgent`, which salt-api has rejected for new agents since
  the 0.73.0 custody change (the SDK's `CreateAgentParams` type doesn't even
  have that field anymore). Registration now sends only `public_key`/
  `public_fingerprint`; the private key stays local, matching the Custody
  section's own (already-correct) description of this plugin's trust model.
- `assets/icon.png` added -- ClawHub's real catalog artwork requirement
  (see "Other decisions worth knowing about" below), a copy of the real
  Salt tile, never hand-drawn.
- `salt-agent-sdk` dependency bumped to `^0.8.0`.
- Left alone: signature verification stays local (`envelope.ts`) -- the SDK
  still has no standalone verifier export, only `createDispatcher`'s
  Express-shaped one (see its own header comment). `addReaction` stays
  local too -- `SaltClient` still has no `react`/`unreact`/`deleteMessage`
  method as of 0.8.0.
- 76 tests passing (was 74), `tsc -p tsconfig.json` clean.

---

Lane `openclaw` (design-fleet/runs/2026-09-17-distribution). Built against
the "Socket mode contract" in that run's `LANES.md`, which a sibling lane
(`socket`) is implementing in salt-api in parallel. As of this handoff, the
`socket` lane's worktree (`.worktrees/socket/salt-api`) has only the two
migrations staged (`add_delivery_mode_to_users`, `create_agent_updates`) --
no controller/route yet -- so this plugin has been built and tested entirely
against the contract's written spec, never against a live implementation.

## What changed

A brand-new standalone repository, `saltapp-openclaw/`, git-initialized with
one local history (no GitHub repo created, nothing published, per the task).
Nothing outside this new repo was touched. The clones used for research
(`~/projects/salt/.worktrees/openclaw-ref/{openclaw,clawhub}`) are read-only
reference checkouts, left in place in case a later lane wants them; they are
not part of this plugin and were never modified.

## Files

```
saltapp-openclaw/
  package.json, tsconfig.json, vitest.config.ts, openclaw.plugin.json
  index.ts, setup-entry.ts             -- OpenClaw entry points
  src/channel.ts, src/channel.test.ts  -- ChannelPlugin object + runtime wiring
  src/types/openclaw-plugin-sdk.d.ts   -- stand-in types for openclaw/plugin-sdk/*
  src/salt/
    envelope.ts, envelope.test.ts       -- HMAC signature verification
    inbound-mapper.ts, inbound-mapper.test.ts  -- envelope -> inbound mapping
    cursor-store.ts, cursor-store.test.ts       -- long-poll cursor persistence
    socket-poller.ts, socket-poller.test.ts     -- the long-poll loop
    outbound.ts, outbound.test.ts               -- encrypt-for-all-members + send
    rest.ts, rest.test.ts                       -- endpoints salt-agent-sdk doesn't wrap yet
    tools.ts, tools.test.ts                     -- salt_post_card / salt_request_payment
  skills/salt-etiquette/SKILL.md        -- bundled OpenClaw skill
  README.md, AGENTS.md, HANDOFF.md, LICENSE, .gitignore
```

No migrations (nothing touches salt-api or any other repo).

## How to test

```bash
cd saltapp-openclaw
npm install
npm install ../salt-agent-sdk --no-save   # local dev only -- see below
npm test          # vitest run
npx tsc -p tsconfig.json --noEmit
npm run build
```

Result at handoff time: **74/74 tests pass**, `tsc --noEmit` clean, `npm run
build` produces `dist/`. All four categories the task named are covered:

- **Envelope -> inbound message mapping**: `src/salt/inbound-mapper.test.ts`
  (13 tests) -- DM vs group classification (inline members, fetched
  members, and the name/public fallback heuristic), mention detection
  (case-insensitive, empty, addressed), lane/roomId handling, system-event
  and no-sender rejection, attachment passthrough. `src/channel.test.ts`
  adds the end-to-end gating behavior on top (group-without-mention is
  silently dropped, group-with-mention and every DM reach the dispatch
  call, self-echo is never answered).
- **Signature rejection**: `src/salt/envelope.test.ts` (9 tests) -- missing
  header, malformed signature, stale signature (case-insensitively matched
  headers, tamper detection on both body and secret).
  `src/salt/socket-poller.test.ts` reuses this at the loop level (a
  bad-signature row is skipped, never reaches the handler, but the cursor
  still advances).
- **Cursor persistence**: `src/salt/cursor-store.test.ts` (7 tests) --
  read-before-write, round-trip, directory auto-creation, overwrite
  semantics, concurrent-write safety (this caught and fixed a real bug --
  see "Bugs this handoff's own testing caught" below).
  `src/salt/socket-poller.test.ts` additionally proves the cursor advances
  across two live poll cycles through a real file-backed store.
- **Outbound encryption for all members (mock REST)**:
  `src/salt/outbound.test.ts` (11 tests) -- encrypts once for every non-self
  member with a known key plus once for the sender's own copy, excludes the
  sender's own id from the recipient set, is case-insensitive on id
  matching, surfaces (never silently drops) a member with no known key,
  refuses to send when NO recipient has a key at all, and the 1:1 case.
  `sendEncryptedReply` proves the full fetch-members -> encrypt -> post path
  end to end against a mocked client.

### Bugs this handoff's own testing caught (fixed before landing)

- `cursor-store.ts`'s temp-file rename could collide under concurrent
  writes in the same process (same millisecond -> same temp filename ->
  the second `rename` saw `ENOENT` because the first had already consumed
  it). Fixed by adding a random suffix to the temp filename. Caught by
  `createFileCursorStore > survives concurrent writes without corrupting
  the file`.
- Several `socket-poller.test.ts` cases originally hardcoded a fixed
  epoch-seconds signing timestamp (`1_700_000_000`, i.e. 2023); against the
  envelope verifier's real wall-clock check (not overridden in
  `pollOnce`/`createSocketPoller`, unlike `envelope.test.ts`'s injectable
  clock) that timestamp goes stale the moment real time passes it by more
  than the 300s tolerance -- which it already had, by tens of millions of
  seconds, by the time this was run. Fixed by signing with
  `Math.floor(Date.now() / 1000)` in every socket-poller test. This is a
  real trap for anyone adding a new test here later; see AGENTS.md's
  testing-conventions note.
- `src/channel.test.ts` initially failed to load at all: `openclaw` is not
  resolvable outside a real OpenClaw checkout, so importing `channel.ts`
  (which does two VALUE-level imports from `openclaw/plugin-sdk/*`, not
  just types) threw "Failed to load url ... Does the file exist?" before a
  single test ran. Fixed with `vi.mock` stand-ins for both subpaths. This
  is expected and duplicated below under "Open questions."

## The CLAUDE.md paragraph you'd add

Not applicable in the usual sense: this is a new standalone repo, not one of
`~/projects/salt/CLAUDE.md`'s existing subprojects, and the lane rules say
not to edit that file. If the coordinator wants Salt's own workspace docs to
mention this plugin exists, a one-line addition to the subproject bullet
list would read something like:

> **`saltapp-openclaw`** — OpenClaw channel plugin giving an OpenClaw agent
> a Salt handle over Salt's socket-mode long-poll contract (no public URL
> required); own repo, own history, published independently to ClawHub/npm.

## User-facing "what's new" candidate

Internal only / not applicable -- this ships nothing in the Salt product
itself (no salt-api, salt-fe, or salt-deploy change). It's a new,
independently-versioned integration in its own repository. If the
coordinator wants a line anywhere Salt's own users would see it (e.g. an
"integrations" page), something like:

> Connect a Salt agent to OpenClaw -- run it on your own machine, no public
> server required.

## UAT steps

There is no live salt-api endpoint to test against yet (the `socket` lane's
route isn't built). Once it is:

1. Register a Salt agent (`salt-agent-sdk`'s `createAgent`, no `webhook`
   set).
2. `npm install && npm run build && openclaw plugins install ./saltapp-openclaw`
   in a real OpenClaw checkout with the compat range (`>=2026.9.4`)
   satisfied.
3. Configure `channels.salt` with the agent's host/id/api-key/PGP
   key+passphrase (see README.md's Setup section) and start the Gateway.
4. Confirm the Gateway log shows the delivery-mode PATCH succeeding (or a
   logged-and-continued failure if the socket route isn't live yet) and the
   poll loop starting.
5. From a second Salt account, open a DM with the agent and send a message
   -- expect a reply.
6. Add the agent to a group with a third account; send a message WITHOUT
   mentioning the agent (expect silence), then @mention it (expect a
   reply).
7. Ask the agent (in a DM) to post a card with two choice buttons; tap one
   from another client; confirm the interaction reaches wherever
   `card_interaction` events are wired (not yet mapped into OpenClaw's turn
   pipeline in this build -- see "Left undone" below, so today this only
   proves the card posts and renders, not that a tap round-trips back).
8. Ask the agent to request a $1 test payment from the second account in
   the DM; confirm the request bubble appears with the right amount/wallet,
   and that the agent's own reply never claims the money was sent.

## Open questions / where this plugin guessed at the OpenClaw plugin SDK

Every spot below is also marked `SDK-INTEGRATION-GUESS` in the source. None
of this plugin's own Salt-side logic (envelope verification, decrypt,
inbound mapping, cursor persistence, outbound encryption -- everything the
task listed as needing tests) depends on these guesses; they're isolated to
the seam between "this plugin has a clean mapped Salt message" and "this
plugin hands it to OpenClaw's actual agent turn machinery."

1. **The real inbound dispatch call.** `docs/plugins/sdk-channel-plugins.md`
   deliberately does not spell this out generically -- it says "Inbound
   message handling is channel-specific... look at a real example in the
   bundled Microsoft Teams or Google Chat plugin package," which this
   effort did not have time to trace end to end (Signal's own
   `monitor/event-handler.ts` alone pulls in 35 named exports from
   `openclaw/plugin-sdk/channel-inbound`, on top of `channel-ingress-runtime`,
   `channel-outbound`, `channel-policy`, `channel-feedback`, `hook-runtime`,
   `reply-history`, `reply-reference`, `routing`, and
   `session-store-runtime` -- a multi-thousand-line pipeline, not a single
   function call, for every bundled channel that has it). This plugin calls
   `runChannelInboundEvent({channelId, raw, chatId, senderId, text, isGroup,
   mentionsSelf})` (`src/channel.ts`'s `createMessageHandler`, renamed from
   `createUpdateHandler` in the 2026-09-22 open-rooms pass above once it
   started reading a `MessageContext` instead of a raw poll update row) as
   the most
   plausible single entrypoint name found by grepping
   `channel-inbound.ts`'s exports, with a hand-written, deliberately loose
   parameter type in `src/types/openclaw-plugin-sdk.d.ts`. **This is
   unverified against the real compiled SDK.** Whoever wires this plugin
   into a real OpenClaw dev harness should start here: trace what a minimal
   bundled channel (Signal is the smallest of the three read) actually
   passes into its own inbound pipeline call and correct this shape.

2. **Recovering the running client/identity inside
   `outbound.attachedResults.sendText`.** RESOLVED 2026-09-22 (open-rooms
   pass): the doc's own example shows `sendText: async (params) => {...}`
   receiving only `params.to`/`params.text` -- no visible way to reach this
   plugin's `SaltClient`, account, or PGP key from inside that closure
   signature alone, and this plugin used to throw a hard "not wired yet"
   error there instead of guessing at an accessor that might not exist.
   Fixed via the module-level runtime registry pattern this entry already
   guessed at: `channel.ts`'s `runtimeRef` (a plain `{current?: SaltRuntimeDeps}`
   box, module-scoped, set once by `startSaltChannel`) -- `sendText`'s
   closure is built at module-load time, before `startSaltChannel` ever
   runs, but reads `runtimeRef.current` at CALL time, so the ordering
   works. `sendText` now branches on `rest.ts#isOpenRoom` and posts plain
   (`postPlainMessage`) or via `createReplySender`, same logic factored
   into the directly-testable `sendChannelText`. Still unverified: whether
   the real OpenClaw host ever calls `sendText` before `registerFull` has
   finished (this now throws a clear message in that case rather than
   silently no-op'ing); trace that ordering guarantee against a real
   compiled host before relying on it in production.

3. **`resolveCurrentChatId` inside a tool's execute call.** Both Salt tools
   (`salt_post_card`, `salt_request_payment`) need "which chat is this turn
   replying in" and currently get it from an injected
   `resolveCurrentChatId(context)` that always returns `undefined`
   (`src/channel.ts`'s `startSaltChannel`) -- meaning **both tools
   currently fail closed (return `null`, so the model never sees them) on
   a real OpenClaw host**, since `context` is `OpenClawPluginToolContext`
   in name only (this plugin's own stand-in). WhatsApp's own
   `whatsapp_call` tool reads `context.requesterSenderId` and
   `context.messageChannel` directly and never needed a "current chat id"
   at all (it calls the requester by phone number, not by chat) -- Salt's
   tools need the chat id specifically, and this effort did not confirm
   the real field name for it. Fix: find a bundled channel's own tool (or
   its shared `message` tool integration) that resolves a current
   conversation id from `OpenClawPluginToolContext` and wire the same
   accessor here.

4. **`security.dm.defaultPolicy: "open"`.** The doc's only shown example
   value is `"allowlist"`. `"open"` is this plugin's own guessed enum member
   (`src/types/openclaw-plugin-sdk.d.ts`), chosen because Salt already gates
   who may open a chat with an agent server-side (`Block.between?`) and
   duplicating that at the OpenClaw layer would be a second, driftable
   source of truth -- but the real SDK's actual accepted values for this
   field were never confirmed.
5. **Plugin-unload hook.** `index.ts` exports `stopSaltChannelForTesting()`
   as a manual escape hatch for stopping the long-poll loop; there is no
   confirmed, documented OpenClaw lifecycle hook this plugin found for
   "the channel/account was disabled or the plugin was unloaded, stop your
   background work." Long-running per-account restart behavior
   (`docs/plugins/sdk-channel-plugins.md`'s "Account-scoped restart
   contract", linked but not read in depth this pass) likely already
   covers this and should replace the manual export once confirmed.

None of the above blocks `npm test`/`npm run build` in this standalone repo
(everything type-checks and runs against this plugin's own mocked
stand-ins), but all five should be treated as **not yet proven inside a
real OpenClaw Gateway** until someone with a running dev harness verifies
them against the actual compiled `openclaw` package.

## Left undone

- **`card_interaction` / `invoice_paid` / `chat_opened` / hand-off events**:
  the socket poller receives and signature-verifies these (they ride the
  same envelope), but `createUpdateHandler` currently only maps and
  dispatches `event === "message"` rows -- everything else is logged and
  dropped (`src/channel.ts`: "ignoring unmapped event kind"). A card tap
  (the other half of `salt_post_card`'s own purpose) therefore does not
  currently reach the agent at all. This needs its own OpenClaw-side
  surface (a tool result? a system event? unclear without open question #1
  above being resolved first) rather than guessing blind.
- ~~**No `assets/icon.png`.**~~ **Fixed 2026-09-22**: `assets/icon.png` is
  now the real Salt tile (a copy of `salt-fe/public/logo512.png`, itself
  `salt-fe/brand/salt-tile.svg` rendered to 512x512 PNG by that folder's
  `build.sh`, ~5KB -- well under ClawHub's 512 KiB cap), not hand-drawn.
  `package.json`'s `files` allowlist already included `"assets"`.
- **No live integration test.** Every test mocks REST and the OpenClaw SDK
  surface; nothing here has run against a real salt-api (the socket route
  doesn't exist yet) or a real OpenClaw Gateway. See UAT steps above for
  what that would look like once both exist.
- **Reactions** (`addReaction` in `src/salt/rest.ts`) are implemented and
  unit-tested but not wired into any tool or automatic behavior -- the task
  said "reactions if the channel API supports them," and Salt's does
  (`POST /api/v1/messages/:id/reactions`), but nothing in this plugin calls
  it yet. Low-risk to add once open question #3 is resolved (it needs a
  message id + chat context the same way the two tools do).
- **Attachments**: `inbound-mapper.ts` carries a decrypted attachment
  through into `SaltInboundMessage.attachment` when the caller supplies
  one, but `src/channel.ts`'s `createUpdateHandler` never actually calls
  `client.getAttachment` + `decryptAttachment` to produce one -- attachments
  arrive as ordinary text-only messages today. The task called attachments
  "only if trivial," and wiring the full get-attachment-then-decrypt path
  correctly (including the image-vs-other-filetype distinction
  `salt-agent-sdk`'s own `DecryptedAttachment` type draws) didn't fit this
  pass.

## ClawHub publish steps

Not run this pass (task: "no GitHub repo, no publish"). For whoever does
publish later, from `docs/publishing.md` in the ClawHub repo:

```bash
npm i -g clawhub
clawhub login

# Before publishing:
clawhub package validate ./saltapp-openclaw
clawhub package publish ./saltapp-openclaw --dry-run

# First real publish (creates the package row):
clawhub package publish ./saltapp-openclaw --owner <your-clawhub-owner>

# Optional: wire GitHub Actions trusted publishing for future releases
clawhub package trusted-publisher set saltapp-openclaw \
  --repository 0000F8/saltapp-openclaw \
  --workflow-filename package-publish.yml
```

Notes for that publish:

- Package name is unscoped (`saltapp-openclaw`, per this workspace's naming
  convention for npm adapters until `@saltapp` exists as a claimed org), so
  there is no `@owner/package` scope-match requirement to satisfy --
  publish under whichever ClawHub owner handle should hold it.
- `openclaw.plugin.json` already declares `"categories": ["communication"]`
  (a current ClawHub plugin category slug) so it skips ClawHub's
  auto-classification step; confirm that's still a valid slug at publish
  time.
- New releases stay out of public install/download surfaces until
  ClawHub's automated security checks and verification finish -- expect a
  delay between publish and the package showing up in search.
- Add `assets/icon.png` (see "Left undone" above) before or shortly after
  the first publish, or the plugin shows the category glyph indefinitely
  (ClawHub only repairs missing icons from a release that already bundled
  one).
