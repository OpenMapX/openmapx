import { afterEach, describe, expect, it, vi } from "vitest";
import { warmChunksOnIdle } from "./warmChunksOnIdle";

function stubServiceWorker(serviceWorker: object) {
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { serviceWorker }));
}

/** A chunk loader whose calls are recorded on `calls`. */
function trackedLoader(result: () => Promise<unknown> = () => Promise.resolve()) {
  const calls = vi.fn();
  const load = () => {
    calls();
    return result();
  };
  return { calls, load };
}

/** Stubs `requestIdleCallback`, exposing the scheduled callback. */
function stubIdleCallback(handle: number) {
  const scheduled: { run?: () => void } = {};
  const requestIdleCallback = vi.fn((...args: unknown[]) => {
    scheduled.run = args[0] as () => void;
    return handle;
  });
  const cancelIdleCallback = vi.fn();
  vi.stubGlobal("requestIdleCallback", requestIdleCallback);
  vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
  return { scheduled, requestIdleCallback, cancelIdleCallback };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("warmChunksOnIdle", () => {
  it("does nothing while no service worker controls the page", () => {
    vi.useFakeTimers();
    stubServiceWorker({});
    const loader = trackedLoader();

    const cleanup = warmChunksOnIdle([loader.load]);
    vi.advanceTimersByTime(20_000);

    expect(loader.calls).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });

  it("runs every loader once when the page becomes idle", () => {
    stubServiceWorker({ controller: {} });
    const { scheduled, requestIdleCallback } = stubIdleCallback(7);
    const first = trackedLoader();
    const second = trackedLoader();

    warmChunksOnIdle([first.load, second.load]);

    expect(first.calls).not.toHaveBeenCalled();
    expect(second.calls).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 10_000 });
    scheduled.run?.();
    expect(first.calls).toHaveBeenCalledTimes(1);
    expect(second.calls).toHaveBeenCalledTimes(1);
  });

  it("cancels the idle callback when cleaned up before it runs", () => {
    stubServiceWorker({ controller: {} });
    const { cancelIdleCallback } = stubIdleCallback(7);

    const cleanup = warmChunksOnIdle([trackedLoader().load]);
    cleanup();

    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("falls back to a timeout where requestIdleCallback is missing", () => {
    vi.useFakeTimers();
    stubServiceWorker({ controller: {} });
    vi.stubGlobal("requestIdleCallback", undefined);
    const loader = trackedLoader();

    warmChunksOnIdle([loader.load]);
    vi.advanceTimersByTime(1_999);
    expect(loader.calls).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(loader.calls).toHaveBeenCalledTimes(1);

    const cancelled = trackedLoader();
    const cleanup = warmChunksOnIdle([cancelled.load]);
    vi.advanceTimersByTime(1_000);
    cleanup();
    vi.advanceTimersByTime(5_000);
    expect(cancelled.calls).not.toHaveBeenCalled();
  });

  it("swallows a loader failure", async () => {
    stubServiceWorker({ controller: {} });
    const { scheduled } = stubIdleCallback(1);
    const loader = trackedLoader(() => Promise.reject(new Error("offline")));

    warmChunksOnIdle([loader.load]);
    scheduled.run?.();
    await Promise.resolve();

    // Vitest fails the file on an unhandled rejection, so reaching here passes.
    expect(loader.calls).toHaveBeenCalledTimes(1);
  });
});
