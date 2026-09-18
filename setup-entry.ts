// Lightweight entry OpenClaw loads instead of index.ts while the `salt`
// channel is disabled or unconfigured (onboarding/setup flows, `--help`,
// etc.) -- avoids pulling in the socket-poller/PGP/tool runtime just to
// show a setup wizard. See docs/plugins/sdk-channel-plugins.md's
// "Add a setup entry" step.

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { saltChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(saltChannelPlugin);
