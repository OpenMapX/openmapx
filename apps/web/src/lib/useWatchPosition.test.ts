// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWatchPosition } from "./useWatchPosition";

afterEach(() => vi.unstubAllGlobals());

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
      cb?.({
        coords: { longitude: 1, latitude: 2, accuracy: 5, heading: 90, speed: 3 },
        timestamp: 1234,
      } as GeolocationPosition);
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
});
