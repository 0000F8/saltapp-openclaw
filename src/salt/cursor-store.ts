// Cursor persistence for the socket-mode long-poll loop.
//
// The socket mode contract's cursor is just "the last update `id` we've
// consumed" (rows with id <= after are never redelivered). This plugin is
// an external/untrusted-until-reviewed OpenClaw plugin, so it cannot use
// `api.runtime.state.openKeyedStore`/`openSyncKeyedStore`/`openBlobStore` --
// those SQLite-backed stores are refused to anything but bundled or
// trusted-official plugin installations (see
// docs/plugins/sdk-runtime/state-and-system.md's "Trusted plugin state
// refused" warning). `api.runtime.state.resolveStateDir(env)` is NOT
// gated, so this plugin resolves a plain directory under it
// (`<stateDir>/plugins/salt/<accountId>/`) and keeps its own small JSON
// file there with plain fs -- exactly what the task's "cursor persisted in
// OpenClaw's plugin state dir" asks for, and the only viable option until
// this plugin earns trusted-install status. See HANDOFF.md.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CursorStore {
  read(): Promise<string | null>;
  write(cursor: string): Promise<void>;
}

interface CursorFileShape {
  cursor: string;
  updatedAt: string;
}

/**
 * A cursor store rooted at an arbitrary directory (created on first write).
 * Safe for concurrent reads; writes are whole-file replace via a temp file
 * + rename so a crash mid-write never corrupts the stored cursor.
 */
export function createFileCursorStore(dir: string, filename = "cursor.json"): CursorStore {
  const filePath = path.join(dir, filename);

  return {
    async read() {
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as CursorFileShape;
        return typeof parsed.cursor === "string" ? parsed.cursor : null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async write(cursor: string) {
      await mkdir(dir, { recursive: true });
      // A random suffix, not just pid+timestamp: two concurrent writes in
      // the same process can land in the same millisecond, which made two
      // writers share one temp path and the second `rename` see ENOENT
      // after the first had already consumed it.
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
      const payload: CursorFileShape = { cursor, updatedAt: new Date().toISOString() };
      await writeFile(tmpPath, JSON.stringify(payload), "utf8");
      await rename(tmpPath, filePath);
    },
  };
}

/**
 * Resolves this plugin's per-account state directory from OpenClaw's plugin
 * state dir. `accountId` defaults to `"default"` (the single-account case
 * -- see the manifest's `channelConfigs.salt`, which has no per-account
 * list yet).
 */
export function resolveSaltCursorDir(openClawStateDir: string, accountId = "default"): string {
  return path.join(openClawStateDir, "plugins", "salt", accountId);
}
