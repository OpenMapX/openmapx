/**
 * Resolves OSM class/type pairs to human-readable English labels using the
 * iD editor's tagging schema (@openstreetmap/id-tagging-schema). The full
 * JSON is loaded once at startup — server-side only, never sent to the client.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type PresetEntry = { name?: string };
type TranslationEntry = { name?: string };
type EnTranslations = { en?: { presets?: { presets?: Record<string, TranslationEntry> } } };

const schema = require("@openstreetmap/id-tagging-schema/dist/presets.json") as Record<
  string,
  PresetEntry
>;

const translations =
  (require("@openstreetmap/id-tagging-schema/dist/translations/en.json") as EnTranslations).en
    ?.presets?.presets ?? {};

// iD names include editing-context qualifiers that are verbose in a display context.
// Strip them wherever they appear as a trailing suffix.
const TRAILING_SUFFIXES = [" Grounds", " Counter", " / Complex"];

function stripSuffix(name: string): string {
  for (const suffix of TRAILING_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

/**
 * Returns a human-readable label for an OSM class + type pair.
 * Priority: iD English translation (suffix-stripped) → title-cased fallback.
 */
export function resolveOsmLabel(osmClass: string, osmType: string): string {
  const key = `${osmClass}/${osmType}`;

  const direct = translations[key]?.name;
  if (direct) return stripSuffix(direct);

  // Some presets use a template reference in their name field, e.g. "{education/university}"
  const nameRef = schema[key]?.name;
  if (nameRef?.startsWith("{") && nameRef.endsWith("}")) {
    const refName = translations[nameRef.slice(1, -1)]?.name;
    if (refName) return stripSuffix(refName);
  }

  // Fallback: title-case the raw type (or class when type is the generic "yes")
  const raw = osmType !== "yes" ? osmType : osmClass;
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
