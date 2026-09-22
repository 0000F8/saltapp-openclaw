// State-directory resolution for this plugin's Salt socket connection.
//
// The actual cursor/dedupe persistence now belongs to salt-agent-sdk's
// `createSocketClient` (its own `FileCursorStore`/`FileDedupeStore`, see
// socket.ts) -- this plugin used to hand-roll its own poll-cursor file
// (`createFileCursorStore` below, now removed) because it also hand-rolled
// the poll loop itself. Now that receiving goes through the SDK's socket
// client, only the DIRECTORY resolution stays this plugin's job: this is
// an external/untrusted-until-reviewed OpenClaw plugin, so it cannot use
// `api.runtime.state.openKeyedStore`/`openSyncKeyedStore`/`openBlobStore` --
// those SQLite-backed stores are refused to anything but bundled or
// trusted-official plugin installations (see
// docs/plugins/sdk-runtime/state-and-system.md's "Trusted plugin state
// refused" warning). `api.runtime.state.resolveStateDir(env)` is NOT
// gated, so this plugin resolves a plain directory under it
// (`<stateDir>/plugins/salt/<accountId>/`) and points the SDK's file-backed
// stores at it -- so a restart still resumes where it left off, same
// property the old hand-rolled cursor file had. See HANDOFF.md.

import path from "node:path";

/**
 * Resolves this plugin's per-account state directory from OpenClaw's plugin
 * state dir. `accountId` defaults to `"default"` (the single-account case
 * -- see the manifest's `channelConfigs.salt`, which has no per-account
 * list yet). Pass this to salt-agent-sdk's `FileCursorStore`/
 * `FileDedupeStore`.
 */
export function resolveSaltCursorDir(openClawStateDir: string, accountId = "default"): string {
  return path.join(openClawStateDir, "plugins", "salt", accountId);
}
