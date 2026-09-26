import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presentOpeningHoursInfo } from "../../utils/openingHoursClient";
import { useOpeningHoursClock } from "../useOpeningHoursClock";

describe("mounted opening-hours freshness", () => {
  afterEach(() => vi.useRealTimers());

  it("neutralizes an unchanged cached object after its calculation expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
    const info = {
      status: { isOpen: true },
      isAlwaysOpen: false,
      weekBitmap: "",
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    const { result } = renderHook(() => {
      const now = useOpeningHoursClock();
      return presentOpeningHoursInfo(info, "Mo-Su 10:00-18:00", now)?.status;
    });
    expect(result.current?.isOpen).toBe(true);
    act(() => vi.advanceTimersByTime(75_000));
    expect(result.current).toMatchObject({ isOpen: false, isUnknown: true });
  });
});
