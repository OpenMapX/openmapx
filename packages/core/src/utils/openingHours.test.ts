import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOpeningHours } from "./openingHours";

// Berlin (CEST = UTC+2 in May). The schedule is evaluated against the place's
// local wall-clock, not the server's (which is UTC in production).
const BERLIN = { lat: 52.516, lon: 13.388, countryCode: "de" };
const HOURS = "Mo-Su 06:30-23:00";

describe("parseOpeningHours — place-local timezone", () => {
  afterEach(() => vi.useRealTimers());

  it("is closed at 01:30 place-local even when the server clock reads 23:30 UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T23:30:00Z")); // 01:30 in Berlin
    const status = parseOpeningHours(HOURS, BERLIN);
    expect(status?.isOpen).toBe(false);
    expect(status?.detail).toMatch(/Opens at 06:30/);
  });

  it("is open at 12:00 place-local", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00Z")); // 12:00 in Berlin
    const status = parseOpeningHours(HOURS, BERLIN);
    expect(status?.isOpen).toBe(true);
    expect(status?.detail).toMatch(/Closes at 23:00/);
  });

  it("uses the place timezone, not the server's — a Tokyo place at the same instant", () => {
    // 23:30 UTC = 08:30 next day in Tokyo (JST, UTC+9) — open.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T23:30:00Z"));
    const tokyo = { lat: 35.68, lon: 139.76, countryCode: "jp" };
    const status = parseOpeningHours(HOURS, tokyo);
    expect(status?.isOpen).toBe(true);
  });
});
