# saltapp-openclaw

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that gives
an OpenClaw agent a handle on [Salt](https://saltapp.ai): humans DM it or
@mention it in group chats, it replies end-to-end encrypted, and it can post
interactive cards and payment requests.

Salt agents normally receive messages over a webhook to a public URL.
OpenClaw usually runs on a laptop with no public URL, so this plugin instead
uses **socket mode**: an adaptively-paced short-poll loop against
`GET /api/v1/agent/updates` (about once a second right after activity,
backing off to about once every five seconds while idle) that receives
exactly what a webhook would have delivered, over a connection this machine
initiates outbound. No inbound port, no tunnel, no public endpoint. The poll
cursor persists to OpenClaw's plugin state dir, so a restart resumes where
it left off instead of replaying Salt's retained outbox.

## What it does

- **Inbound**: short-polls Salt for new updates, verifies each envelope's
  HMAC signature, decrypts the PGP ciphertext, and maps the result into a
  DM-or-group / sender / mentions shape for OpenClaw's agent turn pipeline.
- **Outbound**: encrypts a reply for every current member of the chat (Salt
  is E2E -- there is no server-side fan-out) and posts it; signals typing
  while working.
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
       },
     },
   }
   ```

   `privateKey`/`publicKey`/`passphrase`/`apiKey` are marked `sensitive` in
   the plugin manifest, so OpenClaw's config UI masks them the same way it
   masks a Telegram bot token.

3. **Start (or restart) the Gateway.** On load, the plugin calls
   `PATCH /api/v1/agents/delivery {mode: "socket"}` once (idempotent -- safe
   to call on every boot) and starts the long-poll loop. No further setup
   step is required; there is no webhook URL to register anywhere.

4. Message the agent's Salt handle from another account, or add it to a
   group and @mention it, to confirm it answers.

## How it behaves

- **DMs**: every message is answered (subject to normal OpenClaw agent
  policy -- this plugin only decides whether Salt delivered the message to
  OpenClaw's turn pipeline at all).
- **Groups**: only a message that @mentions this agent's handle reaches
  OpenClaw's turn pipeline. An unaddressed group message is silently
  ignored (Salt's ciphertext is encrypted to every member, including this
  agent, so the plugin sees it decrypt fine -- it just isn't this agent's
  turn to speak).
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
                                           # 0.7.1 is published to the public
                                           # npm registry (it currently sits at 0.1.0 there)
npm test                                  # vitest run
npm run build                             # tsc -> dist/
```

Tests cover this plugin's own logic in isolation (envelope signature
verification and rejection, envelope-to-inbound-message mapping, cursor
persistence, outbound encryption for every chat member) with the REST/PGP
boundary mocked -- they do not require a live salt-api or a real OpenClaw
host. See `HANDOFF.md` for what has and hasn't been verified against a real
compiled OpenClaw SDK.

## Related

- [`salt-agent-sdk`](https://github.com/0000F8/salt-agent-sdk) -- the crypto,
  signature, and REST client this plugin builds on.
- [`salt-claude-agent`](https://github.com/0000F8) -- a full-featured
  webhook-mode Salt agent, useful as a second reference for the protocol.
- `AGENTS.md` -- contributor/agent notes for working in this repo.
- `HANDOFF.md` -- what shipped, how to test it, ClawHub publish steps, and
  the open questions this plugin had to guess at against the OpenClaw
  plugin SDK.
