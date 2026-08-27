import { describe, expect, it, vi } from "vitest";
import { createStatusSnapshotStore } from "./status-snapshot.js";

function controlledClock() {
  let monotonicMs = 0;
  let wallTimeMs = Date.parse("2026-08-24T12:00:00.000Z");
  return {
    now: () => ({ monotonicMs, wallTimeMs }),
    advance: (milliseconds: number) => {
      monotonicMs += milliseconds;
      wallTimeMs += milliseconds;
    },
    setWallTime: (milliseconds: number) => {
      wallTimeMs = milliseconds;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("status snapshot store", () => {
  it("coalesces concurrent reads into one probe fan-out", async () => {
    const clock = controlledClock();
    const pending = deferred<{ marker: string }>();
    const probe = vi.fn(() => pending.promise);
    const store = createStatusSnapshotStore({ probe, now: clock.now });

    const first = store.read();
    const second = store.read();

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    pending.resolve({ marker: "first" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ available: true, data: { marker: "first" }, stale: false }),
      expect.objectContaining({ available: true, data: { marker: "first" }, stale: false }),
    ]);
  });

  it("reuses a successful snapshot for 30 seconds and refreshes at expiry", async () => {
    const clock = controlledClock();
    const probe = vi
      .fn<() => Promise<{ marker: string }>>()
      .mockResolvedValueOnce({ marker: "first" })
      .mockResolvedValueOnce({ marker: "second" });
    const store = createStatusSnapshotStore({ probe, now: clock.now });

    await store.read();
    clock.advance(29_999);
    await expect(store.read()).resolves.toMatchObject({ data: { marker: "first" }, ageMs: 29_999 });
    expect(probe).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await expect(store.read()).resolves.toMatchObject({ data: { marker: "second" }, ageMs: 0 });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("uses monotonic age even when wall time moves backwards", async () => {
    const clock = controlledClock();
    const probe = vi
      .fn<() => Promise<{ marker: string }>>()
      .mockResolvedValueOnce({ marker: "first" })
      .mockResolvedValueOnce({ marker: "second" });
    const store = createStatusSnapshotStore({ probe, now: clock.now });

    await store.read();
    clock.setWallTime(Date.parse("2000-01-01T00:00:00.000Z"));
    clock.advance(30_000);

    await expect(store.read()).resolves.toMatchObject({
      data: { marker: "second" },
      capturedAt: "2000-01-01T00:00:30.000Z",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("serves only an eligible stale snapshot after refresh failure", async () => {
    const clock = controlledClock();
    const probe = vi
      .fn<() => Promise<{ marker: string }>>()
      .mockResolvedValueOnce({ marker: "last-success" })
      .mockRejectedValue(new Error("database password must never escape"));
    const store = createStatusSnapshotStore({ probe, now: clock.now });

    await store.read();
    clock.advance(30_000);
    await expect(store.read()).resolves.toMatchObject({
      available: true,
      data: { marker: "last-success" },
      stale: true,
      refreshErrorClass: "unexpected",
    });

    clock.advance(270_001);
    const unavailable = await store.read();
    expect(unavailable).toMatchObject({
      available: false,
      stale: false,
      refreshErrorClass: "unexpected",
    });
    expect(unavailable).not.toHaveProperty("data");
    expect(JSON.stringify(unavailable)).not.toContain("last-success");
    expect(JSON.stringify(unavailable)).not.toContain("password");
  });

  it("does not retry a failed fan-out more than once per refresh interval", async () => {
    const clock = controlledClock();
    const probe = vi.fn<() => Promise<{ marker: string }>>().mockRejectedValue(new Error("down"));
    const store = createStatusSnapshotStore({ probe, now: clock.now });

    await store.read();
    clock.advance(29_999);
    await store.read();
    expect(probe).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await store.read();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("emits one bounded notification per failed refresh generation", async () => {
    const clock = controlledClock();
    const onRefreshFailure = vi.fn();
    const probe = vi.fn<() => Promise<{ marker: string }>>().mockRejectedValue(new Error("down"));
    const store = createStatusSnapshotStore({ probe, now: clock.now, onRefreshFailure });

    await Promise.all([store.read(), store.read(), store.read()]);
    expect(onRefreshFailure).toHaveBeenCalledTimes(1);
    expect(onRefreshFailure).toHaveBeenLastCalledWith({
      generation: 1,
      errorClass: "unexpected",
    });

    await Promise.all([store.read(), store.read()]);
    expect(onRefreshFailure).toHaveBeenCalledTimes(1);

    clock.advance(30_000);
    await Promise.all([store.read(), store.read()]);
    expect(onRefreshFailure).toHaveBeenCalledTimes(2);
    expect(onRefreshFailure).toHaveBeenLastCalledWith({
      generation: 2,
      errorClass: "unexpected",
    });
  });
});
