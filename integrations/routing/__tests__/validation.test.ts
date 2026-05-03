import { describe, expect, it } from "vitest";
import { parseDateTime, parseTravelMode } from "../validation";

describe("parseTravelMode", () => {
  it("accepts each supported mode and returns it unchanged", () => {
    expect(parseTravelMode("driving")).toBe("driving");
    expect(parseTravelMode("walking")).toBe("walking");
    expect(parseTravelMode("cycling")).toBe("cycling");
    expect(parseTravelMode("transit")).toBe("transit");
  });

  it("normalises uppercase to lowercase before matching", () => {
    expect(parseTravelMode("Driving")).toBe("driving");
    expect(parseTravelMode("WALKING")).toBe("walking");
  });

  it("defaults to driving when value is undefined", () => {
    expect(parseTravelMode(undefined)).toBe("driving");
  });

  it("throws on unknown modes with a list of accepted values", () => {
    expect(() => parseTravelMode("banana")).toThrow(/Invalid mode: "banana"/);
    expect(() => parseTravelMode("banana")).toThrow(/driving, walking, cycling, transit/);
  });

  it("throws on the empty string (not the same as undefined)", () => {
    expect(() => parseTravelMode("")).toThrow(/Invalid mode/);
  });
});

describe("parseDateTime", () => {
  it("returns undefined for undefined / empty input", () => {
    expect(parseDateTime(undefined, "departAt")).toBeUndefined();
    expect(parseDateTime("", "departAt")).toBeUndefined();
  });

  it("normalises ISO inputs with seconds and Z suffix to YYYY-MM-DDTHH:mm", () => {
    expect(parseDateTime("2026-05-04T08:30:00.000Z", "departAt")).toBe("2026-05-04T08:30");
    expect(parseDateTime("2026-05-04T08:30:00", "departAt")).toBe("2026-05-04T08:30");
  });

  it("preserves wall-clock from offset inputs (does not convert to UTC)", () => {
    // We treat the supplied wall-clock as local time at the route origin per
    // Valhalla's contract, so a `+02:00` offset is ignored — the stripped
    // wall-clock prefix is what reaches the engine.
    expect(parseDateTime("2026-05-04T08:30:00+02:00", "departAt")).toBe("2026-05-04T08:30");
  });

  it("rejects malformed inputs", () => {
    expect(() => parseDateTime("not-a-date", "departAt")).toThrow(
      /Invalid departAt: expected ISO-8601 datetime/,
    );
    expect(() => parseDateTime("2026/05/04 08:30", "departAt")).toThrow();
  });

  it("rejects out-of-range numeric components cheaply", () => {
    expect(() => parseDateTime("2026-13-04T08:30", "departAt")).toThrow(
      /out-of-range date or time component/,
    );
    expect(() => parseDateTime("2026-05-32T08:30", "departAt")).toThrow(
      /out-of-range date or time component/,
    );
    expect(() => parseDateTime("2026-05-04T24:00", "departAt")).toThrow(
      /out-of-range date or time component/,
    );
    expect(() => parseDateTime("2026-05-04T08:60", "departAt")).toThrow(
      /out-of-range date or time component/,
    );
  });

  it("rejects calendar-impossible dates that pass the cheap range check", () => {
    // Feb 31 has month <= 12 and day <= 31, so only the round-trip catches it.
    expect(() => parseDateTime("2026-02-31T08:30", "departAt")).toThrow(/not a real calendar date/);
    // Apr 31 — same shape: 30-day month.
    expect(() => parseDateTime("2026-04-31T08:30", "departAt")).toThrow(/not a real calendar date/);
  });

  it("accepts Feb 29 in a leap year and rejects it in a non-leap year", () => {
    expect(parseDateTime("2024-02-29T08:30", "departAt")).toBe("2024-02-29T08:30");
    expect(() => parseDateTime("2025-02-29T08:30", "departAt")).toThrow(/not a real calendar date/);
  });

  it("includes the field name from the second argument in the error", () => {
    expect(() => parseDateTime("garbage", "arriveBy")).toThrow(/Invalid arriveBy/);
  });
});
