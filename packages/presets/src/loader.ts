import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PresetIndexEntry, RawPreset, RawTranslation } from "./types";

const require = createRequire(import.meta.url);

function readJson<T>(specifier: string): T {
  const path = require.resolve(specifier);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function tokenizeAliases(aliases: string[] | string | undefined): string[] {
  if (!aliases) return [];
  // The schema's translation files store `aliases` as a newline-separated string,
  // not an array — accept both shapes defensively.
  const list = Array.isArray(aliases) ? aliases : aliases.split("\n");
  return list.flatMap((a) => normalize(a).split(/\s+/)).filter(Boolean);
}

function tokenizeTerms(terms: string[] | string | undefined): string[] {
  if (!terms) return [];
  const list = Array.isArray(terms) ? terms : terms.split(",");
  return list
    .map((t) => normalize(t))
    .filter(Boolean);
}

let cachedRawPresets: Record<string, RawPreset> | undefined;
function getRawPresets(): Record<string, RawPreset> {
  if (!cachedRawPresets) {
    cachedRawPresets = readJson<Record<string, RawPreset>>(
      "@openstreetmap/id-tagging-schema/dist/presets.min.json",
    );
  }
  return cachedRawPresets;
}

const cachedTranslations = new Map<string, Record<string, RawTranslation>>();
function getTranslations(lang: string): Record<string, RawTranslation> {
  const cached = cachedTranslations.get(lang);
  if (cached) return cached;
  try {
    const file = readJson<{
      [lang: string]: { presets: { presets: Record<string, RawTranslation> } };
    }>(`@openstreetmap/id-tagging-schema/dist/translations/${lang}.json`);
    const map = file[lang]?.presets?.presets ?? {};
    cachedTranslations.set(lang, map);
    return map;
  } catch {
    cachedTranslations.set(lang, {});
    return {};
  }
}

function buildLangIndex(
  lang: string,
  enFallback: Record<string, RawTranslation>,
): PresetIndexEntry[] {
  const presets = getRawPresets();
  const langTranslations = lang === "en" ? enFallback : getTranslations(lang);

  const out: PresetIndexEntry[] = [];
  for (const [presetId, raw] of Object.entries(presets)) {
    if (raw.searchable === false) continue;
    const t = langTranslations[presetId] ?? {};
    const tEn = enFallback[presetId] ?? {};
    const nameSrc = t.name ?? tEn.name ?? presetId;
    const aliasesSrc = t.aliases ?? tEn.aliases ?? [];
    const termsSrc = t.terms ?? tEn.terms ?? "";
    out.push({
      presetId,
      displayName: nameSrc,
      normalizedName: normalize(nameSrc),
      normalizedAliases: tokenizeAliases(aliasesSrc),
      normalizedTerms: tokenizeTerms(termsSrc),
      tags: raw.tags,
      icon: raw.icon,
      matchScore: raw.matchScore ?? 1,
    });
  }
  return out;
}

/**
 * Build the full preset index for the given languages. English is always loaded
 * as the source-locale fallback; languages that lack a translation file produce
 * an index identical to English.
 */
export function loadPresetIndex(langs: readonly string[]): Map<string, PresetIndexEntry[]> {
  const enFallback = getTranslations("en");
  const index = new Map<string, PresetIndexEntry[]>();
  for (const lang of langs) {
    index.set(lang, buildLangIndex(lang, enFallback));
  }
  return index;
}
