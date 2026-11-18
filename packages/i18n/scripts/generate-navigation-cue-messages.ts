#!/usr/bin/env npx tsx
/**
 * Writes generated/navigation-cue-messages.json: the `navigation` messages that
 * navigation cues use, per locale, copied from the canonical catalogues. Browser
 * bundles format cues from this file so they do not ship every catalogue.
 * Translators keep editing locales/*.json; rerun this script afterwards:
 *   pnpm -C packages/i18n exec tsx scripts/generate-navigation-cue-messages.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { locales, messages } from "../config";
import { NAVIGATION_CUE_KEYS } from "../navigationCueFormatter";

export const NAVIGATION_CUE_MESSAGES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "generated",
  "navigation-cue-messages.json",
);

/** Copies only keys a locale actually defines, so a gap still falls back to English. */
export function renderNavigationCueMessages(): string {
  const catalogue = Object.fromEntries(
    locales.map((locale) => {
      const navigation = messages[locale].navigation as Record<string, unknown>;
      return [
        locale,
        Object.fromEntries(
          NAVIGATION_CUE_KEYS.filter((key) => Object.hasOwn(navigation, key)).map((key) => [
            key,
            navigation[key],
          ]),
        ),
      ];
    }),
  );
  return `${JSON.stringify(catalogue, null, 2)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  mkdirSync(dirname(NAVIGATION_CUE_MESSAGES_PATH), { recursive: true });
  writeFileSync(NAVIGATION_CUE_MESSAGES_PATH, renderNavigationCueMessages());
}
