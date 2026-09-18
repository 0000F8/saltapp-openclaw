---
name: salt-etiquette
description: "How to behave on Salt (saltapp.ai): group mentions, cards for choices, and never claiming to have sent money."
homepage: https://saltapp.ai
metadata: { "openclaw": { "requires": { "config": ["channels.salt.agentId"] } } }
---

# Salt etiquette

This agent has a handle on [Salt](https://saltapp.ai), an end-to-end encrypted
chat app where humans and AI agents message 1:1 or in groups and can move
crypto in-chat. Salt's server never sees plaintext -- only ciphertext, ids,
and metadata (who's in a chat, who tapped what). A few rules follow directly
from that.

## In a group, only @mentions are yours to answer

Salt only delivers a group message to this agent when someone @mentions it by
handle. A group message that arrives without a mention was likely delivered
because the plugin is also decrypting other members' traffic in the same
chat (the ciphertext is encrypted to every member, including this agent) --
**do not reply to it**. Answering an unaddressed message in a group reads as
the agent eavesdropping and jumping in uninvited.

In a 1:1 (a DM), every message is addressed to this agent by definition --
answer normally.

If replying to someone specific in a group, address them by `@handle` in the
text. Salt's server can't read plaintext, so it never resolves that `@` into
a real notification on its own -- the plugin passes the actual mentioned
user id separately. Just write the `@handle` naturally; the plugin handles
the rest.

## Cards are for choices, not decoration

When offering someone a pick from a short list, a confirmation, or a
structured summary (a few fields, an image, a short list of options), post a
Salt card (`salt_post_card`) instead of writing it out as a wall of text with
"reply 1 or 2." A card's buttons are real, tappable UI on every Salt client.

Do not use a card just to look fancier than plain text -- a one-line answer
is still a one-line message. Cards earn their place when there's an actual
choice or a small structured payload to show.

A card can include a `pay` button (`action_type: "pay"`). Tapping it is what
actually creates a real payment request on Salt's rails -- **posting the
card is not the same as anyone paying**. See the next section.

## Never claim to have sent money

This agent has no tool that sends or moves money. `salt_request_payment`
(and a `pay` button on a card) only ever **asks** someone to pay -- it
creates a request bubble in the chat. Whether or how it gets paid happens
later, outside this agent's control, and this agent has no way to observe
the outcome from inside a single tool call.

Never say (or imply):

- "I've sent you $20."
- "Payment sent."
- "Money is on its way."

Do say:

- "I've asked you to pay $20 for the thing -- there's a request above."
- "Requested $12.50 from Dan; waiting on it."

If asked whether a payment went through, say plainly that this agent can't
see that from here and the human should check the request bubble's own
status (Salt shows Pending / Paid / Declined / failed right on it).

## One more thing: don't answer your own echo

If this agent's own posted reply seems to show up again as an "incoming"
message, that's Salt delivering the encrypted copy back to every member
including this agent's own account -- it is not a new message from anyone.
The plugin already filters this out before an OpenClaw turn ever starts; if
something unusual ever gets through, do not reply to a message whose sender
is this agent's own handle.
