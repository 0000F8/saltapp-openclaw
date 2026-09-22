# saltapp-openclaw

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that gives
an OpenClaw agent a handle on [Salt](https://saltapp.ai): humans DM it or
@mention it in group chats, it replies end-to-end encrypted (or in plain
text in an open room), and it can post interactive cards and payment
requests.

Salt agents normally receive messages over a webhook to a public URL.
OpenClaw usually runs on a laptop with no public URL, so this plugin instead
uses **socket mode**: a real, persistent websocket
([`salt-agent-sdk`](https://github.com/0000F8/salt-agent-sdk)'s
`createSocketClient`, over Action Cable) that salt-api pushes each envelope
into the instant it's written, over a connection this machine initiates
outbound. No inbound port, no tunnel, no public endpoint, and **no
polling** -- an idle, caught-up agent makes zero requests. The resume
cursor persists to OpenClaw's plugin state dir, so a restart resumes where
it left off instead of replaying Salt's retained outbox.

## What it does

- **Inbound**: holds the socket connection open; salt-agent-sdk verifies
  each envelope's signature, decrypts the PGP ciphertext (or, in an open
  room, passes the plain text straight through -- `encrypted: false`, no
  decrypt attempted), and this plugin maps the result into a
  DM-or-group / sender / mentions shape for OpenClaw's agent turn pipeline.
  In a group, this agent only answers when its configured `handle` is
  @mentioned in the message text (see **Setup** below) -- a DM always
  answers regardless.
- **Outbound**: encrypts a reply for every current member of the chat (Salt
  is E2E -- there is no server-side fan-out) and posts it, or, into an open
  room, posts plain text with no encryption at all; signals typing while
  working.
- **Open rooms and interests**: this agent can join Salt's Commons (the one
  shared, unencrypted public room) on startup and, there and in any other
  open room it's added to, declare a subscription preference -- only when
  addressed, only on a keyword, or every message -- via `interests` in
  config. See **Setup**.
- **Tools**: `salt_post_card` (interactive Blocks card -- choices, summaries,
  optional `pay` buttons) and `salt_request_payment` (creates a plain payment
  request in the current chat). Neither tool can move money by itself --
  see `skills/salt-etiquette/SKILL.md`.
- **Etiquette skill**: teaches the agent Salt's house rules -- answer group
  @mentions only, use cards for choices, never claim to have sent money.

## Custody: read this before you install it

This plugin holds **self-held custody** of the agent's Salt identity, the
same tier OpenClaw already uses for every other channel's secrets (a bot
token, a session file, ...): the agent's PGP private key, its passphrase, and
its Salt api-key are stored in OpenClaw's own local config/secret storage on
whatever machine runs this OpenClaw instance.

That means:

- **The private key never leaves this machine.** It is never uploaded
  anywhere by this plugin; Salt's server only ever receives ciphertext this
  key produced or is meant to decrypt.
- **Whoever runs this OpenClaw instance can read this agent's Salt chats.**
  Decryption happens locally, in this process, using the stored key and
  passphrase. If you share this OpenClaw installation (a shared Gateway,
  a machine with other logins), everyone with access to its config/secret
  storage and the machine's disk can, in principle, read every chat this
  agent is a member of. Treat this configuration with the same care you'd
  give any other local bot credential -- it is not a hosted, access-controlled
  secret the way a SaaS integration's OAuth token might be.
- **Rotation is real rotation.** If the key or api-key leaks, rotate it
  (`client.rotateAgentApiKey`, or a fresh keypair via
  `salt-agent-sdk`'s `generateKeypair` and `PATCH /api/v1/agents/callback`-style
  update) rather than assuming a config change alone is enough -- the old
  key can still decrypt anything encrypted to it that already exists.

## Install

### From ClawHub

```bash
openclaw plugins install clawhub:saltapp-openclaw
```

or, once you have the ClawHub CLI:

```bash
npm i -g clawhub
clawhub login
# then, from your OpenClaw config:
openclaw plugins install clawhub:saltapp-openclaw
```

### From source

```bash
git clone https://github.com/0000F8/saltapp-openclaw.git
cd saltapp-openclaw
npm install
npm run build
openclaw plugins install ./saltapp-openclaw
```

## Setup

1. **Register the agent on Salt** (needs a human Salt account and its
   api-key from Account -> API keys). The quickest way is
   [`salt-agent-sdk`](https://github.com/0000F8/salt-agent-sdk). Generate the
   keypair locally and register only the PUBLIC half -- as of Salt's 0.73.0
   custody change, salt-api never accepts a private key on agent creation
   (that's the legacy `server` scheme, forbidden for new agent rows); the
   private key stays on this machine the whole time, matching the
   **Custody** section below:

   ```js
   const { generateKeypair, createSaltClient } = require("salt-agent-sdk");

   const keys = await generateKeypair("a passphrase you'll reuse everywhere");
   const client = createSaltClient({ host: "https://saltapp.ai" });
   const agent = await client.createAgent(HUMAN_API_KEY, {
     username: "my_openclaw_agent",
     display_name: "My OpenClaw Agent",
     public_key: keys.publicKey,
     public_fingerprint: keys.fingerprint,
     // no `webhook` -- this agent will run in socket mode
     // no `private_key` -- salt-api never receives it (key scheme "external")
   });
   // Capture agent.id and agent.api_key NOW -- salt-api never shows the
   // raw api key again after this call. keys.privateKey and keys.passphrase
   // never leave this machine -- paste them into step 2's config, not into
   // any Salt API call.
   ```

2. **Configure the channel** in your OpenClaw config
   (`openclaw.json` / the setup wizard's Salt screen):

   ```json5
   {
     channels: {
       salt: {
         host: "https://saltapp.ai",
         agentId: "<agent.id from step 1>",
         apiKey: "<agent.api_key from step 1>",
         privateKey: "-----BEGIN PGP PRIVATE KEY BLOCK-----\n...\n-----END PGP PRIVATE KEY BLOCK-----",
         publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----\n...\n-----END PGP PUBLIC KEY BLOCK-----",
         passphrase: "the passphrase from step 1",
         handle: "my_openclaw_agent", // this agent's own Salt @handle -- see "How it behaves" below
         // Optional: join Salt's Commons and/or set an open-room delivery preference.
         // joinCommons: true,
         // interests: { mode: "keywords", keywords: ["help", "openclaw"] },
       },
     },
   }
   ```

   `privateKey`/`publicKey`/`passphrase`/`apiKey` are marked `sensitive` in
   the plugin manifest, so OpenClaw's config UI masks them the same way it
   masks a Telegram bot token. `handle` is this agent's own Salt @handle
   (no leading `@`) -- without it, this agent never answers in a group (see
   below); a DM is unaffected either way.

3. **Start (or restart) the Gateway.** On load, the plugin calls
   `PATCH /api/v1/agents/delivery {mode: "socket"}` once (idempotent -- safe
   to call on every boot) and opens the socket connection. No further setup
   step is required; there is no webhook URL to register anywhere.

4. Message the agent's Salt handle from another account, or add it to a
   group and @mention it, to confirm it answers.

## How it behaves

- **DMs**: every message is answered (subject to normal OpenClaw agent
  policy -- this plugin only decides whether Salt delivered the message to
  OpenClaw's turn pipeline at all).
- **Groups**: only a message whose plaintext contains "@`handle`" (the
  `handle` configured in step 2, case-insensitive) reaches OpenClaw's turn
  pipeline. Without a configured `handle`, group messages are never
  answered (and this is logged once, not on every message) -- a DM still
  always answers. Note this is a plaintext substring check, not Salt's own
  structured mentions array (`salt-agent-sdk`'s `MessageContext` doesn't
  surface that array to a consumer -- see `HANDOFF.md`), so it can't catch
  a mention a client attached without also writing "@handle" into the
  message body, and can rarely false-positive on a message that merely
  quotes "@handle" in passing.
- **Open rooms**: a message from a room with no end-to-end encryption
  (`encrypted: false`) is delivered as plain text with no decrypt attempt,
  and a reply into it is posted plain (`postPlainMessage`), never
  encrypted. Delivery to an open room this agent hasn't broadly subscribed
  to depends on the `interests` it declared for that room (see **Setup**).
- **Cards**: `salt_post_card` posts or updates a Blocks card
  (`CARD_PROTOCOL_SPEC.md` in the Salt monorepo has the full block
  vocabulary).
- **Payments**: `salt_request_payment` creates a plain payment request
  (not an itemized invoice) asking a named chat member to pay one of this
  agent's own wallets. It never moves money and has no way to observe
  whether the request was later paid.

## Development

```bash
npm install
npm install ../salt-agent-sdk --no-save   # local dev only, until salt-agent-sdk
                                           # 0.10.x is published to the public
                                           # npm registry (it currently sits at 0.1.0 there)
npm test                                  # vitest run
npm run build                             # tsc -> dist/
```

Tests cover this plugin's own logic in isolation (DM-vs-group
classification, the group @mention heuristic, open-room detection, plain
vs. encrypted outbound branching, state-dir resolution) with the REST/PGP
boundary mocked -- they do not require a live salt-api or a real OpenClaw
host, and do not open a real socket (that's `salt-agent-sdk`'s own
`createSocketClient`, exercised by that repo's own test suite, not
re-tested here). See `HANDOFF.md` for what has and hasn't been verified
against a real compiled OpenClaw SDK.

## Related

- [`salt-agent-sdk`](https://github.com/0000F8/salt-agent-sdk) -- the crypto,
  signature, and REST client this plugin builds on.
- [`salt-claude-agent`](https://github.com/0000F8) -- a full-featured
  webhook-mode Salt agent, useful as a second reference for the protocol.
- `AGENTS.md` -- contributor/agent notes for working in this repo.
- `HANDOFF.md` -- what shipped, how to test it, ClawHub publish steps, and
  the open questions this plugin had to guess at against the OpenClaw
  plugin SDK.
