import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSaltCursorDir } from "./cursor-store.js";

describe("resolveSaltCursorDir", () => {
  it("scopes the cursor dir under plugins/salt/<accountId>", () => {
    expect(resolveSaltCursorDir("/state", "default")).toBe(
      path.join("/state", "plugins", "salt", "default"),
    );
  });

  it("defaults accountId to 'default'", () => {
    expect(resolveSaltCursorDir("/state")).toBe(path.join("/state", "plugins", "salt", "default"));
  });
});
