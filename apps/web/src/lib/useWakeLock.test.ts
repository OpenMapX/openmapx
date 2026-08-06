// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWakeLock } from "./useWakeLock";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event("visibilitychange"));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A fake `WakeLockSentinel` whose own "release" event can be fired to simulate the browser dropping the lock. */
function makeSentinel() {
  let onRelease: (() => void) | null = null;
  return {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn((...args: unknown[]) => {
      const [event, cb] = args as [string, () => void];
      if (event === "release") onRelease = cb;
    }),
    removeEventListener: vi.fn(),
    fireRelease: () => onRelease?.(),
  };
}
type FakeSentinel = ReturnType<typeof makeSentinel>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("useWakeLock", () => {
  it("requests a screen wake lock when active", async () => {
    const sentinel = makeSentinel();
    const request = vi.fn().mockResolvedValue(sentinel);
    vi.stubGlobal("navigator", { wakeLock: { request } });
    // jsdom's real `document` defaults to visibilityState "visible"; keep it so
    // testing-library can mount the hook host element.

    renderHook(() => useWakeLock(true));
    await flush();
    expect(request).toHaveBeenCalledWith("screen");
  });

  it("is a no-op without wakeLock support", () => {
    vi.stubGlobal("navigator", {});
    // Leave jsdom's real `document` in place so testing-library can mount; the
    // hook short-circuits on the missing wakeLock capability before touching it.
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
  });

  it("releases a sentinel that resolves after deactivation, and never stores it", async () => {
    const { promise, resolve } = deferred<FakeSentinel>();
    const request = vi.fn().mockReturnValue(promise);
    vi.stubGlobal("navigator", { wakeLock: { request } });

    const { rerender } = renderHook(({ active }: { active: boolean }) => useWakeLock(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });

    const sentinel = makeSentinel();
    await act(async () => {
      resolve(sentinel);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("releases a sentinel that resolves after the tab was hidden again", async () => {
    const { promise, resolve } = deferred<FakeSentinel>();
    const request = vi.fn().mockReturnValue(promise);
    vi.stubGlobal("navigator", { wakeLock: { request } });

    renderHook(() => useWakeLock(true));
    setVisibility("hidden");

    const sentinel = makeSentinel();
    await act(async () => {
      resolve(sentinel);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("collapses repeated visibilitychange events into a single in-flight request", async () => {
    const { promise } = deferred<FakeSentinel>();
    const request = vi.fn().mockReturnValue(promise);
    vi.stubGlobal("navigator", { wakeLock: { request } });

    renderHook(() => useWakeLock(true));
    fireVisibilityChange();
    fireVisibilityChange();
    fireVisibilityChange();
    await act(async () => {
      await Promise.resolve();
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a browser-initiated release clears the ref and allows re-acquisition", async () => {
    const sentinel1 = makeSentinel();
    const sentinel2 = makeSentinel();
    let requestCount = 0;
    const request = vi.fn(() => Promise.resolve(requestCount++ === 0 ? sentinel1 : sentinel2));
    vi.stubGlobal("navigator", { wakeLock: { request } });

    renderHook(() => useWakeLock(true));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    act(() => sentinel1.fireRelease());
    fireVisibilityChange();
    await flush();

    expect(request).toHaveBeenCalledTimes(2);
    expect(sentinel1.release).not.toHaveBeenCalled();
    expect(sentinel2.release).not.toHaveBeenCalled();
  });

  it("handles a request rejection without throwing", async () => {
    const request = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { wakeLock: { request } });

    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
    await flush();
  });

  it("releases once on deactivation (arrival) after the lock was acquired", async () => {
    const sentinel = makeSentinel();
    const request = vi.fn().mockResolvedValue(sentinel);
    vi.stubGlobal("navigator", { wakeLock: { request } });

    const { rerender } = renderHook(({ active }: { active: boolean }) => useWakeLock(active), {
      initialProps: { active: true },
    });
    await flush();

    rerender({ active: false });
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("releases once on unmount after the lock was acquired", async () => {
    const sentinel = makeSentinel();
    const request = vi.fn().mockResolvedValue(sentinel);
    vi.stubGlobal("navigator", { wakeLock: { request } });

    const { unmount } = renderHook(() => useWakeLock(true));
    await flush();

    unmount();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });
});
