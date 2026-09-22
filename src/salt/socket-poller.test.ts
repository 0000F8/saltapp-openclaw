import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFileCursorStore } from "./cursor-store.js";
import { createSocketPoller, pollOnce, type SocketUpdateRow } from "./socket-poller.js";

const SECRET = "test-secret";

function signed(id: number, body: string, t = Math.floor(Date.now() / 1000)): SocketUpdateRow {
  const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return {
    id,
    event: "message",
    headers: { "X-Salt-Agent-Id": "agent-self", "X-Salt-Signature": `t=${t},v1=${v1}` },
    body,
    created_at: "2026-09-18T00:00:00Z",
  };
}

function memoryCursorStore() {
  let value: string | null = null;
  return {
    async read() {
      return value;
    },
    async write(cursor: string) {
      value = cursor;
    },
  };
}

describe("pollOnce", () => {
  it("passes verified rows to onUpdate and advances the cursor", async () => {
    const row = signed(5, JSON.stringify({ message: { chat_id: "1" } }));
    const cursorStore = memoryCursorStore();
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    const result = await pollOnce({
      fetchUpdates: async (after) => {
        // Round-4 socket contract (LANES.md K2): a fresh/never-written
        // cursor omits `after` entirely rather than sending "0", so
        // salt-api's own server-side ack applies.
        expect(after).toBeUndefined();
        return { updates: [row], cursor: "5" };
      },
      getSigningSecret: async () => SECRET,
      cursorStore,
      onUpdate,
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ id: "5", event: "message" });
    expect(result.processed).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(await cursorStore.read()).toBe("5");
  });

  it("skips rows with a bad signature, still advances the cursor, and never calls onUpdate for them", async () => {
    const goodRow = signed(1, JSON.stringify({ message: { chat_id: "1" } }));
    const badRow: SocketUpdateRow = {
      id: 2,
      event: "message",
      headers: {
        "X-Salt-Agent-Id": "agent-self",
        "X-Salt-Signature": `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`,
      },
      body: JSON.stringify({ message: { chat_id: "2" } }),
      created_at: "2026-09-18T00:00:00Z",
    };
    const cursorStore = memoryCursorStore();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await pollOnce({
      fetchUpdates: async () => ({ updates: [goodRow, badRow], cursor: "2" }),
      getSigningSecret: async () => SECRET,
      cursorStore,
      onUpdate,
      logger,
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ id: "1" });
    expect(result.skipped).toEqual([{ id: "2", reason: "bad signature" }]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("bad signature"));
    expect(await cursorStore.read()).toBe("2");
  });

  it("skips a row with an invalid JSON body without throwing", async () => {
    const t = Math.floor(Date.now() / 1000);
    const body = "not json";
    const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    const row: SocketUpdateRow = {
      id: 3,
      event: "message",
      headers: { "X-Salt-Agent-Id": "agent-self", "X-Salt-Signature": `t=${t},v1=${v1}` },
      body,
      created_at: "2026-09-18T00:00:00Z",
    };
    const cursorStore = memoryCursorStore();
    const onUpdate = vi.fn();

    const result = await pollOnce({
      fetchUpdates: async () => ({ updates: [row], cursor: "3" }),
      getSigningSecret: async () => SECRET,
      cursorStore,
      onUpdate,
    });

    expect(onUpdate).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([{ id: "3", reason: "invalid JSON body" }]);
  });

  it("still advances the cursor past a row whose handler throws", async () => {
    const row = signed(4, JSON.stringify({ message: { chat_id: "1" } }));
    const cursorStore = memoryCursorStore();
    const onUpdate = vi.fn().mockRejectedValue(new Error("handler exploded"));
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await pollOnce({
      fetchUpdates: async () => ({ updates: [row], cursor: "4" }),
      getSigningSecret: async () => SECRET,
      cursorStore,
      onUpdate,
      logger,
    });

    expect(result.skipped).toEqual([{ id: "4", reason: "handler failed: handler exploded" }]);
    expect(await cursorStore.read()).toBe("4");
  });

  it("uses the cursor store's persisted value as `after` on the next call", async () => {
    const cursorStore = memoryCursorStore();
    await cursorStore.write("99");
    const fetchUpdates = vi.fn().mockResolvedValue({ updates: [], cursor: "99" });

    await pollOnce({ fetchUpdates, getSigningSecret: async () => SECRET, cursorStore, onUpdate: vi.fn() });

    expect(fetchUpdates).toHaveBeenCalledWith("99", 2, 50);
  });

  it("persists the cursor across cycles via a real file-backed cursor store", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "saltapp-openclaw-poll-"));
    try {
      const cursorStore = createFileCursorStore(dir);
      const rowA = signed(10, JSON.stringify({ message: { chat_id: "1" } }));
      const rowB = signed(20, JSON.stringify({ message: { chat_id: "1" } }));

      await pollOnce({
        fetchUpdates: async (after) => {
          expect(after).toBeUndefined();
          return { updates: [rowA], cursor: "10" };
        },
        getSigningSecret: async () => SECRET,
        cursorStore,
        onUpdate: vi.fn(),
      });

      await pollOnce({
        fetchUpdates: async (after) => {
          expect(after).toBe("10");
          return { updates: [rowB], cursor: "20" };
        },
        getSigningSecret: async () => SECRET,
        cursorStore,
        onUpdate: vi.fn(),
      });

      expect(await cursorStore.read()).toBe("20");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createSocketPoller", () => {
  it("polls repeatedly until stop() is called", async () => {
    const cursorStore = memoryCursorStore();
    let calls = 0;
    const fetchUpdates = vi.fn().mockImplementation(async () => {
      calls += 1;
      return { updates: [], cursor: "0" };
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const handle = createSocketPoller(
      { fetchUpdates, getSigningSecret: async () => SECRET, cursorStore, onUpdate: vi.fn() },
      { sleep, idleDelayMs: 5 },
    );

    // Let a few cycles run.
    for (let i = 0; i < 5 && calls < 3; i++) {
      await Promise.resolve();
      await Promise.resolve();
    }
    handle.stop();
    await handle.done;

    expect(fetchUpdates.mock.calls.length).toBeGreaterThan(0);
  });

  it("backs off with increasing delay on repeated fetch errors, then stops cleanly", async () => {
    const cursorStore = memoryCursorStore();
    const fetchUpdates = vi.fn().mockRejectedValue(new Error("network down"));
    const sleepDelays: number[] = [];
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      sleepDelays.push(ms);
      if (sleepDelays.length >= 3) handle.stop();
    });
    const logger = { info: vi.fn(), error: vi.fn() };

    const handle = createSocketPoller(
      { fetchUpdates, getSigningSecret: async () => SECRET, cursorStore, onUpdate: vi.fn(), logger },
      { sleep, errorBackoffMs: 100, maxErrorBackoffMs: 1000 },
    );

    await handle.done;

    expect(sleepDelays[0]).toBe(100);
    expect(sleepDelays[1]).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("network down"));
  });

  it("ramps the idle delay up toward idleDelayMs across consecutive empty polls, then snaps back to activeDelayMs on activity", async () => {
    const cursorStore = memoryCursorStore();
    const row = signed(1, JSON.stringify({ message: { chat_id: "1" } }));
    // Cycle 1: empty. Cycle 2: empty. Cycle 3: one row (activity). Cycle 4: empty again. Then stop.
    let cycle = 0;
    const fetchUpdates = vi.fn().mockImplementation(async () => {
      cycle += 1;
      if (cycle === 3) return { updates: [row], cursor: "1" };
      return { updates: [], cursor: cycle > 3 ? "1" : "0" };
    });
    const sleepDelays: number[] = [];
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      sleepDelays.push(ms);
      if (sleepDelays.length >= 4) handle.stop();
    });

    const handle = createSocketPoller(
      { fetchUpdates, getSigningSecret: async () => SECRET, cursorStore, onUpdate: vi.fn() },
      { sleep, activeDelayMs: 10, idleDelayMs: 25 },
    );

    await handle.done;

    // idle, idle (ramping toward the 25ms ceiling in 10ms steps) -> activity (snaps back to 10ms) -> idle again (ramps back up).
    expect(sleepDelays).toEqual([20, 25, 10, 20]);
  });
});
