import { describe, expect, it } from "vitest";
import deFixture from "./__fixtures__/valhalla-verbal-de-DE.json";
import enFixture from "./__fixtures__/valhalla-verbal-en-US.json";
import { locales } from "./index";
import type { NavigationCueReference } from "./navigationCueFormatter";
import {
  formatCueDistance,
  formatNavigationCue,
  NavigationCueError,
  type NavigationCueIntent,
  resetNavigationCueCache,
} from "./navigationCues";
import {
  REFERENCE_STARTER_EXCLUSIONS,
  startsWithReferenceStarter,
} from "./navigationReferenceStarters";

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
    expect(text).toBe(`Turn left onto ${street}`);
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

describe("reference phrasing", () => {
  const near = (instruction: string, reference: NavigationCueReference): NavigationCueIntent => ({
    kind: "ground-maneuver",
    tier: "near",
    instruction,
    distanceMeters: 120,
    reference,
  });

  it("en: At the second traffic light, turn right …", () => {
    expect(
      formatNavigationCue(
        near("Turn right onto Main Street.", { kind: "traffic-light", ordinal: 2 }),
        "en",
      ),
    ).toBe("At the second traffic light, turn right onto Main Street.");
  });

  it("de: An der zweiten Ampel biegen Sie rechts ab …", () => {
    expect(
      formatNavigationCue(
        near("Rechts auf Hauptstraße abbiegen.", { kind: "traffic-light", ordinal: 2 }),
        "de",
      ),
    ).toBe("An der zweiten Ampel rechts auf Hauptstraße abbiegen.");
    expect(
      formatNavigationCue(
        near("Biegen Sie rechts ab.", { kind: "traffic-light", ordinal: 1 }),
        "de",
      ),
    ).toBe("An der ersten Ampel biegen Sie rechts ab.");
    expect(
      formatNavigationCue(
        near("Leicht nach links abbiegen.", { kind: "traffic-light", ordinal: 3 }),
        "de",
      ),
    ).toBe("An der dritten Ampel leicht nach links abbiegen.");
  });

  it("de: Bei der Aral-Tankstelle … (brand)", () => {
    expect(
      formatNavigationCue(
        near("Links abbiegen.", { kind: "landmark", category: "fuel", brand: "Aral" }),
        "de",
      ),
    ).toBe("Bei der Aral-Tankstelle links abbiegen.");
    expect(
      formatNavigationCue(near("Links abbiegen.", { kind: "landmark", category: "fuel" }), "de"),
    ).toBe("Bei der Tankstelle links abbiegen.");
    expect(
      formatNavigationCue(
        near("Links abbiegen.", { kind: "landmark", category: "supermarket", brand: "REWE" }),
        "de",
      ),
    ).toBe("Beim REWE-Supermarkt links abbiegen.");
    expect(
      formatNavigationCue(
        near("Links abbiegen.", { kind: "landmark", category: "fast_food", brand: "McDonald's" }),
        "de",
      ),
    ).toBe("Bei McDonald's links abbiegen.");
  });

  it.each([
    ["church", "An der Kirche"],
    ["mosque", "An der Moschee"],
    ["synagogue", "An der Synagoge"],
    ["pharmacy", "Bei der Apotheke"],
    ["supermarket", "Beim Supermarkt"],
  ] as const)("de: %s takes its article (%s …)", (category, phrase) => {
    expect(
      formatNavigationCue(near("Rechts abbiegen.", { kind: "landmark", category }), "de"),
    ).toBe(`${phrase} rechts abbiegen.`);
  });

  it("en: At McDonald's, …", () => {
    expect(
      formatNavigationCue(
        near("Turn left onto Elm Road.", {
          kind: "landmark",
          category: "fast_food",
          brand: "McDonald's",
        }),
        "en",
      ),
    ).toBe("At McDonald's, turn left onto Elm Road.");
    expect(
      formatNavigationCue(
        near("Bear right.", { kind: "landmark", category: "fuel", brand: "Shell" }),
        "en",
      ),
    ).toBe("At the Shell petrol station, bear right.");
    expect(
      formatNavigationCue(near("Turn right.", { kind: "landmark", category: "church" }), "en"),
    ).toBe("At the church, turn right.");
  });

  it("speaks the category word for a brand on a category without one", () => {
    expect(
      formatNavigationCue(
        near("Turn right.", { kind: "landmark", category: "pharmacy", brand: "DocMorris" }),
        "en",
      ),
    ).toBe("At the pharmacy, turn right.");
  });

  it("falls back to the distance for unbranded fast food", () => {
    expect(
      formatNavigationCue(near("Turn right.", { kind: "landmark", category: "fast_food" }), "en"),
    ).toBe("In 100 metres, Turn right.");
  });

  it("no reference when the instruction starts with a word off the allowlist", () => {
    const reference = { kind: "traffic-light", ordinal: 1 } as const;
    expect(formatNavigationCue(near("Your destination is on the right.", reference), "en")).toBe(
      "In 100 metres, Your destination is on the right.",
    );
    expect(formatNavigationCue(near("An der Ausfahrt 20 abfahren.", reference), "de")).toBe(
      "In 100 Meter, An der Ausfahrt 20 abfahren.",
    );
  });

  it("far and now tiers ignore the reference", () => {
    const reference = { kind: "traffic-light", ordinal: 2 } as const;
    expect(
      formatNavigationCue(
        {
          kind: "ground-maneuver",
          tier: "far",
          instruction: "Turn right.",
          distanceMeters: 400,
          reference,
        },
        "en",
      ),
    ).toBe("In 400 metres, Turn right.");
    expect(
      formatNavigationCue(
        { kind: "ground-maneuver", tier: "now", instruction: "Turn right.", reference },
        "en",
      ),
    ).toBe("Turn right.");
  });

  it.each([
    { kind: "traffic-light", ordinal: 4 },
    { kind: "traffic-light", ordinal: 0 },
    { kind: "traffic-light", ordinal: 1.5 },
    { kind: "traffic-light", ordinal: "2" },
    { kind: "landmark", category: "casino" },
    { kind: "landmark", category: "fuel", brand: "" },
    { kind: "landmark", category: "fuel", brand: "x".repeat(41) },
    { kind: "billboard" },
  ])("an invalid reference is refused: %j", (reference) => {
    expect(() => formatNavigationCue(near("Turn right.", reference as never), "en")).toThrow(
      NavigationCueError,
    );
  });

  it("treats a brand as plain text", () => {
    expect(
      formatNavigationCue(
        near("Turn right.", { kind: "landmark", category: "fuel", brand: "{instruction}" }),
        "en",
      ),
    ).toBe("At the {instruction} petrol station, turn right.");
  });
});

describe("reference starters", () => {
  it("matches the first word case-insensitively, ignoring punctuation", () => {
    expect(startsWithReferenceStarter("Turn right.", "en")).toBe(true);
    expect(startsWithReferenceStarter("  keep, left", "en")).toBe(true);
    expect(startsWithReferenceStarter("Turnip ahead", "en")).toBe(false);
    expect(startsWithReferenceStarter("Rechts abbiegen.", "de")).toBe(true);
    expect(startsWithReferenceStarter("Turn right.", "de")).toBe(false);
    expect(startsWithReferenceStarter("", "en")).toBe(false);
  });

  it.each([
    ["en", enFixture],
    ["de", deFixture],
  ] as const)(
    "every %s fixture first word is either allowlisted or documented as excluded",
    (locale, fixture) => {
      for (const word of Object.keys(fixture.firstWords)) {
        const allowed = startsWithReferenceStarter(word, locale);
        const excluded = word in REFERENCE_STARTER_EXCLUSIONS[locale];
        expect(allowed !== excluded, `${locale} "${word}"`).toBe(true);
      }
    },
  );
});
