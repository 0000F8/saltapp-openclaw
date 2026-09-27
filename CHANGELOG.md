# Changelog

## 0.1.1

**Open rooms are actually detected now.** `isOpenRoom` compared `chat.encrypted === false` against
`GET /api/v1/chats/:id`, whose payload nests every chat-level field under `session` — so the read was
always `undefined`, every chat looked encrypted, and both open-room paths (plain-text sends, and
applying interests to a newly opened room) were unreachable. It failed closed, so nothing leaked, but
a test named for posting plain text into an open room used the same wrong-shaped fixture and had been
certifying a path that could not execute. Fixed, fixtures corrected in both test files, coverage added
for a session-encrypted room and for a stray top-level flag with no session. Packaging: the `openclaw`
manifest pointed `extensions`/`setupEntry` at `./index.js` and `./setup-entry.js`, files that never
ship because only `dist/` is published; `salt-agent-sdk` is required at `^0.12.2`, the version this
plugin is actually built against; and a rejected webhook signature no longer triggers a secret refetch
(shape check plus an attempt-gated cooldown).

