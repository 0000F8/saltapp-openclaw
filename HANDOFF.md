# HANDOFF.md

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
   mentionsSelf})` (`src/channel.ts`'s `createUpdateHandler`) as the most
   plausible single entrypoint name found by grepping
   `channel-inbound.ts`'s exports, with a hand-written, deliberately loose
   parameter type in `src/types/openclaw-plugin-sdk.d.ts`. **This is
   unverified against the real compiled SDK.** Whoever wires this plugin
   into a real OpenClaw dev harness should start here: trace what a minimal
   bundled channel (Signal is the smallest of the three read) actually
   passes into its own inbound pipeline call and correct this shape.

2. **Recovering the running client/identity inside
   `outbound.attachedResults.sendText`.** The doc's own example shows
   `sendText: async (params) => {...}` receiving only `params.to`/
   `params.text` -- no visible way to reach this plugin's `SaltClient`,
   account, or PGP key from inside that closure signature alone. This
   plugin's `saltChannelPlugin.outbound.attachedResults.sendText`
   deliberately throws a clear "not wired yet" error rather than guess at
   an accessor that might not exist, so a broken guess doesn't masquerade
   as working. The REAL send path this plugin proved end to end is
   `createReplySender` (`src/channel.ts`), which the socket bridge itself
   uses directly with its own resolved client/account -- it just isn't
   reachable through the shared `message` tool's declared `outbound`
   surface yet. Fixing this needs either a documented per-call context
   argument on `sendText` this effort didn't find, or a module-level
   runtime registry pattern (several bundled channels' `runtime-api.ts` /
   `setRuntime` files hint at this, but weren't traced fully).

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
