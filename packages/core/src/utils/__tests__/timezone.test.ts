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

/**
 * Simulates an engine whose CLDR `gmtZeroFormat` renders a zero UTC offset as
 * a bare "GMT" (no sign, no digits) for the localized-GMT `timeZoneName`
 * variants, instead of V8's "GMT+00:00"/"GMT+0" — this is the shape
 * `tzOffsetMinutes`'s regex previously rejected outright, returning `null`
 * for every zero-offset zone on such an engine.
 */
function withBareGmtZeroFormat<T>(fn: () => T): T {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  const stub = new Proxy(RealDateTimeFormat, {
    construct(target, args) {
      const instance = Reflect.construct(target, args) as Intl.DateTimeFormat;
      const options = args[1] as Intl.DateTimeFormatOptions | undefined;
      if (options?.timeZoneName !== "longOffset" && options?.timeZoneName !== "shortOffset") {
        return instance;
      }
      return new Proxy(instance, {
        get(target2, prop, receiver) {
          if (prop === "format") {
            return (date?: Date | number) =>
              instance.format(date).replace(/GMT[+-]0+(?::00)?\b/, "GMT");
          }
          return Reflect.get(target2, prop, receiver);
        },
      });
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

  it("treats a bare GMT (CLDR's zero-offset format on some engines) as zero", () => {
    expect(withBareGmtZeroFormat(() => tzOffsetMinutes(WINTER, "UTC"))).toBe(0);
    expect(withBareGmtZeroFormat(() => tzOffsetMinutes(WINTER, "Africa/Abidjan"))).toBe(0);
  });

  it("leaves non-zero offsets unaffected under the bare-GMT engine", () => {
    expect(withBareGmtZeroFormat(() => tzOffsetMinutes(WINTER, "Europe/Berlin"))).toBe(60);
    expect(withBareGmtZeroFormat(() => tzOffsetMinutes(WINTER, "America/New_York"))).toBe(-300);
  });

  it("still returns null for an unrecognized zone id under the bare-GMT engine", () => {
    expect(withBareGmtZeroFormat(() => tzOffsetMinutes(WINTER, "Mars/Olympus"))).toBeNull();
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

  it("renders UTC for a bare-GMT zero offset under the bare-GMT engine", () => {
    expect(withBareGmtZeroFormat(() => tzOffsetLabel(WINTER, "UTC"))).toBe("UTC");
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

  it("still resolves a diff against a bare-GMT zero-offset zone, rather than going null for every place worldwide", () => {
    // Regression for the case a UK-based viewer would have hit in winter: a
    // bare-GMT zero offset for the viewer's own zone must not poison every
    // diff computed against it.
    expect(withBareGmtZeroFormat(() => tzDiffMinutes(WINTER, "Europe/London", "Asia/Tokyo"))).toBe(
      540,
    );
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
