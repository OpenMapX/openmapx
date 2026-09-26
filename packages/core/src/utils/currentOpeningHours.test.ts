import { afterEach, describe, expect, it, vi } from "vitest";
import { currentOpeningHoursInfo } from "./currentOpeningHours";
import { matchingOpeningHours, presentOpeningHoursInfo } from "./openingHoursClient";

const raw = "Tu-Su,PH 10:00-18:00";
const point = { lat: 50.775736, lon: 6.0830154 };

describe("current opening hours", () => {
  afterEach(() => vi.useRealTimers());

  it("evaluates list and detail schedules with the same Aachen holiday context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
    const list = await currentOpeningHoursInfo(raw, point);
    const detail = await currentOpeningHoursInfo(raw, { ...point, countryCode: "de" });
    expect(list?.status?.isUnknown).toBeFalsy();
    expect(list?.status).toEqual(detail?.status);
    expect(list?.weekBitmap).toEqual(detail?.weekBitmap);
    expect(list?.validUntil).toBeDefined();
  });

  it("keeps unresolved PH schedules neutral", async () => {
    const info = await currentOpeningHoursInfo(raw, { lat: 0, lon: 0 });
    expect(info?.status?.isUnknown).toBe(true);
  });

  it("does not assert a school-holiday verdict without a subdivision", async () => {
    const info = await currentOpeningHoursInfo("Mo-Fr 10:00-18:00; SH off", {
      ...point,
      countryCode: "de",
    });
    expect(info?.status?.isUnknown).toBe(true);
  });

  it("expires a cached verdict while keeping its raw schedule available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
    const info = await currentOpeningHoursInfo("Mo-Su 10:00-18:00", point);
    if (!info) throw new Error("Expected evaluated hours");
    expect(presentOpeningHoursInfo(info, raw, Date.now())?.status?.isUnknown).toBeFalsy();
    vi.advanceTimersByTime(61_000);
    const stale = presentOpeningHoursInfo(info, raw, Date.now());
    expect(stale?.status).toMatchObject({ isUnknown: true, isOpen: false, text: raw });
    expect(stale?.isAlwaysOpen).toBe(false);
    expect(stale?.weekBitmap).toBe("");
    expect(
      presentOpeningHoursInfo({ ...info, validUntil: undefined }, raw)?.status?.isUnknown,
    ).toBe(true);
  });

  it("does not carry a Nominatim verdict or source onto a different chosen schedule", () => {
    const now = Date.now();
    const chosen = matchingOpeningHours(
      "Mo-Fr 09:00-17:00",
      [
        {
          openingHours: "24/7",
          openingHoursInfo: {
            status: { isOpen: true },
            isAlwaysOpen: true,
            weekBitmap: "f".repeat(42),
            validUntil: new Date(now + 60_000).toISOString(),
          },
          openingHoursSource: { name: "OpenStreetMap" },
        },
      ],
      now,
    );
    expect(chosen.info?.status).toMatchObject({ isUnknown: true, text: "Mo-Fr 09:00-17:00" });
    expect(chosen.source).toBeUndefined();
  });
});
