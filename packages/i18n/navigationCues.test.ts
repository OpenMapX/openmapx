import { describe, expect, it } from "vitest";
import { locales } from "./index";
import {
  formatCueDistance,
  formatNavigationCue,
  NavigationCueError,
  type NavigationCueIntent,
  resetNavigationCueCache,
} from "./navigationCues";

/** Every intent shape, used to assert bilingual coverage in one place. */
const ALL_INTENTS: NavigationCueIntent[] = [
  {
    kind: "ground-maneuver",
    tier: "far",
    instruction: "Turn right onto Hauptstraße",
    distanceMeters: 400,
  },
  { kind: "ground-maneuver", tier: "near", instruction: "Turn right", distanceMeters: 120 },
  { kind: "ground-maneuver", tier: "now", instruction: "Turn right" },
  { kind: "walk", action: "Turn left" },
  { kind: "walk", action: "Turn left", street: "Kaiserstraße" },
  { kind: "walk", action: "Take the elevator", level: 2 },
  { kind: "board", line: "S8", destination: "Wiesbaden" },
  { kind: "board", line: "S8", destination: "Wiesbaden", platform: "3" },
  { kind: "alight", stop: "Hauptbahnhof" },
  { kind: "transfer", stop: "Hauptwache", line: "U6" },
  { kind: "platform-change", platform: "4" },
  { kind: "off-route" },
  { kind: "weak-gps" },
  { kind: "schedule-fallback" },
  { kind: "permission-lost" },
  { kind: "arrival" },
];

describe("bilingual coverage", () => {
  it.each(locales)("formats every intent in %s with no unresolved placeholder", (locale) => {
    for (const intent of ALL_INTENTS) {
      const text = formatNavigationCue(intent, locale);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("[object");
    }
  });

  it("produces different text for the two locales where the phrasing differs", () => {
    const intent: NavigationCueIntent = { kind: "arrival" };
    expect(formatNavigationCue(intent, "en")).not.toBe(formatNavigationCue(intent, "de"));
  });

  it("uses the canonical catalogue rather than a private phrase list", () => {
    expect(formatNavigationCue({ kind: "board", line: "S8", destination: "Wiesbaden" }, "de")).toBe(
      "Steig in die S8 Richtung Wiesbaden",
    );
  });
});

describe("ground maneuvers", () => {
  it("includes a spoken distance for the far and near tiers", () => {
    expect(
      formatNavigationCue(
        { kind: "ground-maneuver", tier: "far", instruction: "Turn right", distanceMeters: 400 },
        "en",
      ),
    ).toBe("In 400 metres, Turn right");
  });

  it("omits the distance for the imminent tier", () => {
    expect(
      formatNavigationCue(
        { kind: "ground-maneuver", tier: "now", instruction: "Turn right", distanceMeters: 20 },
        "en",
      ),
    ).toBe("Turn right");
  });

  it("omits the distance when none was supplied", () => {
    expect(
      formatNavigationCue(
        { kind: "ground-maneuver", tier: "far", instruction: "Turn right" },
        "en",
      ),
    ).toBe("Turn right");
  });
});

describe("formatCueDistance", () => {
  it.each([
    [40, "en", "metric", "40 metres"],
    [44, "en", "metric", "40 metres"],
    [420, "en", "metric", "400 metres"],
    [1_500, "en", "metric", "1.5 kilometres"],
    [12_000, "en", "metric", "12 kilometres"],
  ] as const)("speaks %i m as %s", (meters, locale, units, expected) => {
    expect(formatCueDistance(meters, locale, units)).toBe(expected);
  });

  it("rounds coarsely far out and finely close in", () => {
    expect(formatCueDistance(37, "en", "metric")).toBe("40 metres");
    expect(formatCueDistance(430, "en", "metric")).toBe("450 metres");
  });

  it("supports imperial units", () => {
    expect(formatCueDistance(30, "en", "imperial")).toBe("100 feet");
    expect(formatCueDistance(5_000, "en", "imperial")).toBe("3.1 miles");
  });

  it("localises the unit word", () => {
    expect(formatCueDistance(400, "de", "metric")).toBe("400 Meter");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects the distance %p", (meters) => {
    expect(() => formatCueDistance(meters, "en", "metric")).toThrow(NavigationCueError);
  });
});

describe("input validation", () => {
  it.each(["fr", "en-US", "", null, undefined, 42])("rejects the locale %p", (locale) => {
    expect(() => formatNavigationCue({ kind: "arrival" }, locale as never)).toThrow(
      NavigationCueError,
    );
  });

  it.each(["", "   ", "x".repeat(121)])("rejects the free-text value %p", (street) => {
    expect(() => formatNavigationCue({ kind: "walk", action: "Turn left", street }, "en")).toThrow(
      NavigationCueError,
    );
  });

  it("rejects an oversized instruction", () => {
    expect(() =>
      formatNavigationCue(
        { kind: "ground-maneuver", tier: "now", instruction: "x".repeat(241) },
        "en",
      ),
    ).toThrow(NavigationCueError);
  });

  it.each([1.5, 9_999, Number.NaN])("rejects the implausible level %p", (level) => {
    expect(() =>
      formatNavigationCue({ kind: "walk", action: "Take the lift", level }, "en"),
    ).toThrow(NavigationCueError);
  });

  it("rejects an empty line or destination", () => {
    expect(() =>
      formatNavigationCue({ kind: "board", line: "", destination: "X" }, "en"),
    ).toThrow();
    expect(() =>
      formatNavigationCue({ kind: "board", line: "S8", destination: "" }, "en"),
    ).toThrow();
  });

  it("rejects an unknown intent rather than speaking nothing", () => {
    expect(() => formatNavigationCue({ kind: "self-destruct" } as never, "en")).toThrow(
      NavigationCueError,
    );
  });
});

describe("interpolation safety", () => {
  it.each([
    "<b>Main Street</b>",
    "{destination}",
    "</speak><audio src='x'/>",
    "Main & Third",
    "'quoted''",
  ])("treats %s as plain text", (street) => {
    const text = formatNavigationCue({ kind: "walk", action: "Turn left", street }, "en");
    // The value must survive as text; what matters is that no tag or nested
    // placeholder is interpreted, and nothing is dropped silently.
    expect(text.startsWith("Turn left onto ")).toBe(true);
    expect(text.length).toBeGreaterThan("Turn left onto ".length);
  });

  it("does not resolve a placeholder smuggled inside a value", () => {
    const text = formatNavigationCue(
      { kind: "board", line: "{destination}", destination: "Wiesbaden" },
      "en",
    );
    expect(text).toContain("Wiesbaden");
    // The line name must not have been substituted a second time.
    expect(text.match(/Wiesbaden/g)).toHaveLength(1);
  });
});

describe("caching", () => {
  it("returns identical output before and after a cache reset", () => {
    const intent: NavigationCueIntent = { kind: "alight", stop: "Hauptbahnhof" };
    const first = formatNavigationCue(intent, "de");
    resetNavigationCueCache();
    expect(formatNavigationCue(intent, "de")).toBe(first);
  });

  it("keeps locales separate in the cache", () => {
    const intent: NavigationCueIntent = { kind: "alight", stop: "Hauptbahnhof" };
    const en = formatNavigationCue(intent, "en");
    const de = formatNavigationCue(intent, "de");
    expect(en).not.toBe(de);
    expect(formatNavigationCue(intent, "en")).toBe(en);
  });
});
