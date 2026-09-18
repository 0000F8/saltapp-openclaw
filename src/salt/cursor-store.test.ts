import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileCursorStore, resolveSaltCursorDir } from "./cursor-store.js";

describe("createFileCursorStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "saltapp-openclaw-cursor-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads null when nothing has been written yet", async () => {
    const store = createFileCursorStore(dir);
    expect(await store.read()).toBeNull();
  });

  it("round-trips a written cursor", async () => {
    const store = createFileCursorStore(dir);
    await store.write("42");
    expect(await store.read()).toBe("42");
  });

  it("creates the directory on first write when it does not exist yet", async () => {
    const nested = path.join(dir, "nested", "account-1");
    const store = createFileCursorStore(nested);
    await store.write("7");
    expect(await store.read()).toBe("7");
  });

  it("overwrites a previous cursor rather than appending", async () => {
    const store = createFileCursorStore(dir);
    await store.write("1");
    await store.write("2");
    await store.write("3");
    expect(await store.read()).toBe("3");
  });

  it("survives concurrent writes without corrupting the file", async () => {
    const store = createFileCursorStore(dir);
    await Promise.all([store.write("10"), store.write("11"), store.write("12")]);
    const value = await store.read();
    expect(["10", "11", "12"]).toContain(value);
  });
});

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
