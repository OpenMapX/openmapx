import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as configModule from "./config";
import * as localeModule from "./locale";
import { defaultLocale, localeNames, locales } from "./locale";

const IMPORT_SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function importSpecifiers(file: string): string[] {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const specifiers = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.add(specifier);
  }
  return [...specifiers].sort();
}

describe("locale registry", () => {
  it("lists every registered catalogue in registration order", () => {
    expect([...locales]).toEqual(Object.keys(configModule.messages));
    expect(Object.keys(localeNames)).toEqual([...locales]);
    expect(locales).toContain(defaultLocale);
  });

  it("re-exports the same locale helpers from the catalogue registry", () => {
    expect(configModule.resolveLocale).toBe(localeModule.resolveLocale);
    expect(configModule.locales).toBe(localeModule.locales);
    expect(configModule.defaultLocale).toBe(localeModule.defaultLocale);
    expect(configModule.localeNames).toBe(localeModule.localeNames);
  });
});

describe("browser module import boundary", () => {
  const boundaryMessage =
    "is bundled into the web client and must not import ./config, ./index, ./translator, ./navigationCues or ./locales/*, which carry every message catalogue";

  it.each([
    ["locale.ts", []],
    [
      "navigationCueFormatter.ts",
      ["./locale", "./navigationReferenceStarters", "intl-messageformat"],
    ],
    ["navigationReferenceStarters.ts", ["./locale"]],
    [
      "navigationCuesCompact.ts",
      [
        "./generated/navigation-cue-messages.json",
        "./navigationCueFormatter",
        "./navigationReferenceStarters",
      ],
    ],
  ])("%s imports only catalogue-free modules", (file, expected) => {
    expect(importSpecifiers(file), `${file} ${boundaryMessage}`).toEqual(expected);
  });
});
