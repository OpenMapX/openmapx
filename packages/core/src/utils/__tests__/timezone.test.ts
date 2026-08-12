import { describe, expect, it } from "vitest";
import { formatInTimeZone, tzDiffMinutes, tzOffsetLabel, tzOffsetMinutes } from "../timezone";

const WINTER = new Date("2026-01-15T12:00:00Z");
const SUMMER = new Date("2026-07-15T12:00:00Z");

/**
 * Safari 16.0-16.3 doesn't recognize `timeZoneName: "longOffset"` and throws
 * a RangeError from the `Intl.DateTimeFormat` constructor itself — this
 * reproduces exactly that by rejecting only that option value and delegating
 * everything else (including the id-only validation call) to the real
 * constructor, so `shortOffset` remains available as the retry path.
 */
function withLongOffsetUnsupported<T>(fn: () => T): T {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  const stub = new Proxy(RealDateTimeFormat, {
    construct(target, args) {
      const options = args[1] as Intl.DateTimeFormatOptions | undefined;
      if (options?.timeZoneName === "longOffset") {
        throw new RangeError("Value longOffset out of range for option timeZoneName");
      }
      return Reflect.construct(target, args);
    },
  });
  Intl.DateTimeFormat = stub;
  try {
    return fn();
  } finally {
    Intl.DateTimeFormat = RealDateTimeFormat;
  }
}

describe("tzOffsetMinutes", () => {
  it("follows northern-hemisphere DST", () => {
    expect(tzOffsetMinutes(WINTER, "Europe/Berlin")).toBe(60);
    expect(tzOffsetMinutes(SUMMER, "Europe/Berlin")).toBe(120);
  });

  it("follows southern-hemisphere DST in the opposite direction", () => {
    expect(tzOffsetMinutes(WINTER, "Australia/Sydney")).toBe(660);
    expect(tzOffsetMinutes(SUMMER, "Australia/Sydney")).toBe(600);
  });

  it("handles sub-hour offsets", () => {
    expect(tzOffsetMinutes(WINTER, "Asia/Kathmandu")).toBe(345);
  });

  it("handles negative offsets", () => {
    expect(tzOffsetMinutes(WINTER, "America/New_York")).toBe(-300);
  });

  it("handles POSIX-inverted Etc zones", () => {
    expect(tzOffsetMinutes(WINTER, "Etc/GMT+5")).toBe(-300);
    expect(tzOffsetMinutes(WINTER, "Etc/GMT-5")).toBe(300);
  });

  it("returns null for an unrecognized zone id", () => {
    expect(tzOffsetMinutes(WINTER, "Mars/Olympus")).toBeNull();
  });

  it("falls back to shortOffset and matches the primary path when longOffset is unsupported", () => {
    const zones: Array<[Date, string]> = [
      [SUMMER, "Europe/Berlin"], // whole-hour
      [WINTER, "Asia/Kathmandu"], // sub-hour
      [WINTER, "America/New_York"], // negative
      [WINTER, "UTC"], // zero
    ];
    for (const [date, timeZone] of zones) {
      const primary = tzOffsetMinutes(date, timeZone);
      const viaFallback = withLongOffsetUnsupported(() => tzOffsetMinutes(date, timeZone));
      expect(viaFallback).toBe(primary);
    }
  });

  it("still returns null for an unrecognized zone id when longOffset is unsupported", () => {
    expect(withLongOffsetUnsupported(() => tzOffsetMinutes(WINTER, "Mars/Olympus"))).toBeNull();
  });
});

describe("tzOffsetLabel", () => {
  it("renders whole and fractional offsets", () => {
    expect(tzOffsetLabel(SUMMER, "Europe/Berlin")).toBe("UTC+2");
    expect(tzOffsetLabel(WINTER, "Asia/Kathmandu")).toBe("UTC+5:45");
    expect(tzOffsetLabel(WINTER, "America/New_York")).toBe("UTC-5");
    expect(tzOffsetLabel(WINTER, "UTC")).toBe("UTC");
  });

  it("returns null for an unrecognized zone id", () => {
    expect(tzOffsetLabel(WINTER, "Mars/Olympus")).toBeNull();
  });
});

describe("tzDiffMinutes", () => {
  it("is the signed difference between two zones at an instant", () => {
    expect(tzDiffMinutes(SUMMER, "Europe/Berlin", "Asia/Tokyo")).toBe(420);
    expect(tzDiffMinutes(SUMMER, "Asia/Tokyo", "Europe/Berlin")).toBe(-420);
    expect(tzDiffMinutes(SUMMER, "Europe/Berlin", "Europe/Berlin")).toBe(0);
  });

  it("returns null when either zone is unrecognized", () => {
    expect(tzDiffMinutes(SUMMER, "Mars/Olympus", "Europe/Berlin")).toBeNull();
    expect(tzDiffMinutes(SUMMER, "Europe/Berlin", "Mars/Olympus")).toBeNull();
  });
});

describe("formatInTimeZone", () => {
  it("renders the wall clock of the target zone", () => {
    expect(formatInTimeZone(new Date("2026-07-15T10:00:00Z"), "Europe/Berlin", "en-GB")).toBe(
      "12:00",
    );
    expect(formatInTimeZone(new Date("2026-07-15T10:00:00Z"), "Asia/Tokyo", "en-GB")).toBe("19:00");
  });

  it("returns null for an unrecognized zone id", () => {
    expect(formatInTimeZone(new Date("2026-07-15T10:00:00Z"), "Mars/Olympus", "en-GB")).toBeNull();
  });
});
