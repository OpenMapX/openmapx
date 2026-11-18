import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { messages } from "./config";
import { NavigationCueError as BarrelNavigationCueError } from "./index";
import { locales } from "./locale";
import {
  createNavigationCueFormatter,
  NAVIGATION_CUE_KEYS,
  type NavigationCueIntent,
} from "./navigationCueFormatter";
import {
  NavigationCueError as RegistryNavigationCueError,
  formatNavigationCue as registryFormatNavigationCue,
} from "./navigationCues";
import { formatNavigationCue, NavigationCueError } from "./navigationCuesCompact";
import {
  NAVIGATION_CUE_MESSAGES_PATH,
  renderNavigationCueMessages,
} from "./scripts/generate-navigation-cue-messages";

/** Every intent shape, used to assert parity with the registry formatter. */
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

describe("generated cue catalogue", () => {
  it("matches the canonical catalogues", () => {
    expect(
      readFileSync(NAVIGATION_CUE_MESSAGES_PATH, "utf8"),
      "generated/navigation-cue-messages.json is stale; run pnpm -C packages/i18n exec tsx scripts/generate-navigation-cue-messages.ts",
    ).toBe(renderNavigationCueMessages());
  });

  it.each(locales)("lists only cue keys that exist as strings in %s", (locale) => {
    const navigation = messages[locale].navigation as Record<string, unknown>;
    for (const key of NAVIGATION_CUE_KEYS) {
      expect(typeof navigation[key], `navigation.${key} in ${locale}`).toBe("string");
    }
  });
});

describe("parity with the registry formatter", () => {
  it.each(locales)("formats every intent in %s identically", (locale) => {
    for (const units of ["metric", "imperial"] as const) {
      for (const intent of ALL_INTENTS) {
        expect(formatNavigationCue(intent, locale, { units })).toBe(
          registryFormatNavigationCue(intent, locale, { units }),
        );
      }
    }
  });

  it("throws the same NavigationCueError class as the registry and the barrel", () => {
    expect(NavigationCueError).toBe(RegistryNavigationCueError);
    expect(NavigationCueError).toBe(BarrelNavigationCueError);
    const emptyInstruction: NavigationCueIntent = {
      kind: "ground-maneuver",
      tier: "now",
      instruction: "",
    };
    for (const format of [formatNavigationCue, registryFormatNavigationCue]) {
      expect(() => format(emptyInstruction, "en")).toThrow(NavigationCueError);
      expect(() => format({ kind: "self-destruct" } as never, "en")).toThrow(NavigationCueError);
    }
  });
});

describe("createNavigationCueFormatter fallback", () => {
  it("falls back to English when a locale lacks a key", () => {
    const formatter = createNavigationCueFormatter({ en: { arrived: "EN arrived" }, de: {} });
    expect(formatter.formatNavigationCue({ kind: "arrival" }, "de")).toBe("EN arrived");
  });

  it("prefers the locale's own message over English", () => {
    const formatter = createNavigationCueFormatter({
      en: { arrived: "EN arrived" },
      de: { arrived: "DE angekommen" },
    });
    expect(formatter.formatNavigationCue({ kind: "arrival" }, "de")).toBe("DE angekommen");
  });

  it("throws when neither the locale nor English has the key", () => {
    const formatter = createNavigationCueFormatter({ en: {}, de: {} });
    const format = () => formatter.formatNavigationCue({ kind: "arrival" }, "de");
    expect(format).toThrow(NavigationCueError);
    expect(format).toThrow(/^missing navigation message: arrived$/);
  });
});
