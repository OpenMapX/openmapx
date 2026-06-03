// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHeading } from "./useHeading";

afterEach(() => vi.unstubAllGlobals());

type OrientListener = (
  e: Partial<DeviceOrientationEvent> & { webkitCompassHeading?: number },
) => void;

describe("useHeading", () => {
  it("reads iOS webkitCompassHeading when present", () => {
    const listeners: Record<string, OrientListener> = {};
    vi.stubGlobal("window", {
      DeviceOrientationEvent: () => {},
      addEventListener: (t: string, cb: OrientListener) => {
        listeners[t] = cb;
      },
      removeEventListener: vi.fn(),
    });
    const { result } = renderHook(() => useHeading(true));
    act(() => listeners.deviceorientation?.({ webkitCompassHeading: 123 }));
    expect(result.current).toBeCloseTo(123, 0);
  });

  it("returns null when inactive", () => {
    vi.stubGlobal("window", {
      DeviceOrientationEvent: () => {},
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const { result } = renderHook(() => useHeading(false));
    expect(result.current).toBeNull();
  });
});
