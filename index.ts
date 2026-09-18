// Full plugin entry point. OpenClaw loads this when the `salt` channel is
// enabled and configured; otherwise it loads setup-entry.ts instead (see
// docs/plugins/sdk-channel-plugins.md's "Add a setup entry" step).
//
// registerCliMetadata runs even during a metadata-only load (root `--help`
// etc.) without pulling in the channel runtime; registerFull is where the
// socket-mode bridge and the two Salt tools actually start, and only runs
// on a full load.

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { saltChannelPlugin, startSaltChannel } from "./src/channel.js";

let stopChannel: (() => void) | undefined;

export default defineChannelPluginEntry({
  id: "salt",
  name: "Salt",
  description: "Connect an OpenClaw agent to Salt (saltapp.ai) over its socket-mode long-poll contract.",
  plugin: saltChannelPlugin,
  registerCliMetadata(api) {
    api.registerCli?.(
      ({ program }: any) => {
        program.command("salt").description("Salt channel management");
      },
      {
        descriptors: [{ name: "salt", description: "Salt channel management", hasSubcommands: false }],
      },
    );
  },
  async registerFull(api) {
    const handle = await startSaltChannel(api);
    stopChannel = handle.stop;
  },
});

// Exported for a host/test harness that wants a clean shutdown hook; not
// part of the documented ChannelPlugin/entry contract (SDK-INTEGRATION-GUESS
// -- there is no documented plugin-unload hook this was verified against;
// see HANDOFF.md).
export function stopSaltChannelForTesting(): void {
  stopChannel?.();
}
