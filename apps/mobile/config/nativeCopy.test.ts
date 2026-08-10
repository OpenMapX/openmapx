import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANDROID_FOREGROUND_SERVICE_COPY,
  IOS_USAGE_DESCRIPTIONS,
  MOBILE_LOCALES,
  resolveMobileLocale,
} from "./nativeCopy";

const localeFile = (locale: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "locales", `${locale}.json`), "utf8"));

describe("iOS locale files", () => {
  // Expo's `locales` field takes file paths, so the usage descriptions exist
  // both as JSON (for the generated `InfoPlist.strings`) and as TypeScript (for
  // `app.config.ts`). This test is what stops the two from drifting.
  it.each(MOBILE_LOCALES)("mirrors the %s TypeScript catalog exactly", (locale) => {
    expect(localeFile(locale)).toEqual(IOS_USAGE_DESCRIPTIONS[locale]);
  });
});

describe("native copy completeness", () => {
  it.each(MOBILE_LOCALES)("has non-empty %s strings for every OS-rendered surface", (locale) => {
    const values = [
      ...Object.values(IOS_USAGE_DESCRIPTIONS[locale]),
      ...Object.values(ANDROID_FOREGROUND_SERVICE_COPY[locale]),
    ];
    for (const value of values) expect(value.trim().length).toBeGreaterThan(0);
  });

  it("explains background use and how tracking stops in every locale", () => {
    for (const locale of MOBILE_LOCALES) {
      const always = IOS_USAGE_DESCRIPTIONS[locale].NSLocationAlwaysAndWhenInUseUsageDescription;
      expect(always.length).toBeGreaterThan(80);
      expect(always).toMatch(locale === "en" ? /background/i : /Hintergrund/i);
      expect(always).toMatch(locale === "en" ? /stops/i : /endet/i);
    }
  });

  it("never reuses the same sentence for foreground and background purposes", () => {
    for (const locale of MOBILE_LOCALES) {
      const strings = IOS_USAGE_DESCRIPTIONS[locale];
      expect(strings.NSLocationWhenInUseUsageDescription).not.toBe(
        strings.NSLocationAlwaysAndWhenInUseUsageDescription,
      );
    }
  });
});

describe("resolveMobileLocale", () => {
  it.each([
    ["de", "de"],
    ["de-DE", "de"],
    ["DE-at", "de"],
    ["en", "en"],
    ["en-GB", "en"],
    ["fr", "en"],
    ["", "en"],
    [undefined, "en"],
    [null, "en"],
  ])("maps %p to %s", (input, expected) => {
    expect(resolveMobileLocale(input)).toBe(expected);
  });
});
