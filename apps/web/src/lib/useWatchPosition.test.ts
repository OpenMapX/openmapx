// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWatchPosition } from "./useWatchPosition";

afterEach(() => vi.unstubAllGlobals());

function makeFix(overrides: Partial<GeolocationCoordinates> = {}) {
  return {
    coords: { longitude: 1, latitude: 2, accuracy: 5, heading: 90, speed: 3, ...overrides },
    timestamp: 1234,
  } as GeolocationPosition;
}

describe("useWatchPosition", () => {
  it("subscribes to watchPosition when active and emits fixes", () => {
    let cb: ((p: GeolocationPosition) => void) | null = null;
    const watchPosition = vi.fn((...args: unknown[]) => {
      cb = args[0] as (p: GeolocationPosition) => void;
      return 7;
    });
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch } });

    const onFix = vi.fn();
    renderHook(() => useWatchPosition(true, onFix));
    expect(watchPosition).toHaveBeenCalled();

    act(() => {
      cb?.(makeFix());
    });
    expect(onFix).toHaveBeenCalledWith(
      expect.objectContaining({
        coords: [1, 2],
        accuracy: 5,
        heading: 90,
        speed: 3,
        timestampMs: 1234,
      }),
    );
  });

  it("does not subscribe when inactive", () => {
    const watchPosition = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch: vi.fn() } });
    renderHook(() => useWatchPosition(false, vi.fn()));
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it("holds exactly one active watch — an unrelated re-render (a new onFix identity) does not open a second one", () => {
    const watchPosition = vi.fn(() => 1);
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch } });

    const { rerender } = renderHook(
      ({ onFix }: { onFix: (p: unknown) => void }) => useWatchPosition(true, onFix),
      { initialProps: { onFix: vi.fn() } },
    );
    expect(watchPosition).toHaveBeenCalledTimes(1);

    // `onFix` is read through a ref, not a hook dependency — a fresh function
    // identity per render must not tear down and reopen the watch.
    rerender({ onFix: vi.fn() });
    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(clearWatch).not.toHaveBeenCalled();
  });

  it("passes the exact high-accuracy options — a safety contract, not a tuning knob (see useWatchPosition.ts)", () => {
    const watchPosition = vi.fn(() => 1);
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch: vi.fn() } });

    renderHook(() => useWatchPosition(true, vi.fn()));
    const options = watchPosition.mock.calls[0]?.[2];
    expect(options).toEqual({ enableHighAccuracy: true, maximumAge: 1000, timeout: 15_000 });
  });

  it("forwards position callbacks unchanged, fix by fix", () => {
    let cb: ((p: GeolocationPosition) => void) | null = null;
    const watchPosition = vi.fn((...args: unknown[]) => {
      cb = args[0] as (p: GeolocationPosition) => void;
      return 1;
    });
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch: vi.fn() } });

    const onFix = vi.fn();
    renderHook(() => useWatchPosition(true, onFix));

    act(() => cb?.(makeFix({ longitude: 10, latitude: 20, accuracy: 8, heading: 45, speed: 1 })));
    act(() => cb?.(makeFix({ longitude: 11, latitude: 21, accuracy: 9, heading: 46, speed: 2 })));

    expect(onFix).toHaveBeenCalledTimes(2);
    const calls = onFix.mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ coords: [10, 20], accuracy: 8, heading: 45, speed: 1 });
    expect(calls[1]?.[0]).toMatchObject({ coords: [11, 21], accuracy: 9, heading: 46, speed: 2 });
  });

  it("clears the watch on deactivate", () => {
    const watchPosition = vi.fn(() => 42);
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch } });

    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useWatchPosition(active, vi.fn()),
      { initialProps: { active: true } },
    );
    rerender({ active: false });
    expect(clearWatch).toHaveBeenCalledWith(42);
  });

  it("clears the watch on unmount", () => {
    const watchPosition = vi.fn(() => 99);
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch } });

    const { unmount } = renderHook(() => useWatchPosition(true, vi.fn()));
    unmount();
    expect(clearWatch).toHaveBeenCalledWith(99);
  });

  it("switching active off then back on re-subscribes exactly once per transition", () => {
    let nextId = 1;
    const watchPosition = vi.fn(() => nextId++);
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch } });

    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useWatchPosition(active, vi.fn()),
      { initialProps: { active: true } },
    );
    expect(watchPosition).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    expect(clearWatch).toHaveBeenCalledTimes(1);
    expect(clearWatch).toHaveBeenCalledWith(1);

    rerender({ active: true });
    expect(watchPosition).toHaveBeenCalledTimes(2);
  });

  // NOTE: `useWatchPosition` has no cancellation guard for a callback that
  // arrives after `clearWatch` — it relies entirely on the platform's
  // contract that `clearWatch(id)` stops further delivery for that id (real
  // browsers honour this). The fake `watchPosition` above can technically be
  // made to invoke its captured callback after the hook has unmounted or
  // deactivated, but doing so would exercise no protective logic in the hook
  // (there is none, by design) and the callback would still reach `onFix` —
  // asserting it is "ignored" would not describe the hook's real contract, so
  // that case is intentionally not asserted here.
});
