import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  EditorFieldEntry,
  EditorIndex,
  EditorLang,
  EditorPresetEntry,
  EditorPresetText,
  OsmEditorGeometry,
  RawDeprecation,
  RawEditorField,
  RawEditorPreset,
} from "./editor-types";

const require = createRequire(import.meta.url);

/** Languages whose schema translations we load. Matches the app's UI locales. */
export const EDITOR_LANGS: readonly EditorLang[] = ["en", "de"];

/**
 * The only schema fields the v1 editor exposes. A new editable fact requires a
 * deliberate addition here plus server policy, UI and legal copy — it can never
 * appear by widening a loop over the schema.
 */
export const EDITOR_FIELD_IDS: readonly string[] = [
  "name",
  "opening_hours",
  "phone",
  "email",
  "website",
  "wheelchair",
  "address",
];

/**
 * Lifecycle prefixes describe a state the curated editor deliberately refuses
 * to create or transform; see the OSM lifecycle-prefix documentation.
 */
const LIFECYCLE_PREFIXES = [
  "disused",
  "abandoned",
  "razed",
  "demolished",
  "removed",
  "was",
  "construction",
  "proposed",
  "planned",
] as const;

function readJson<T>(specifier: string): T {
  return JSON.parse(readFileSync(require.resolve(specifier), "utf8")) as T;
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function tokenizeTerms(terms: string[] | string | undefined): string[] {
  if (!terms) return [];
  const list = Array.isArray(terms) ? terms : terms.split(",");
  return list.map((term) => normalize(term)).filter(Boolean);
}

function normalizeGeometry(geometry: RawEditorPreset["geometry"]): readonly OsmEditorGeometry[] {
  if (!geometry) return [];
  const out: OsmEditorGeometry[] = [];
  for (const value of geometry) {
    // A vertex is a node that happens to be part of a way; for editing
    // purposes it is still a point.
    const mapped: OsmEditorGeometry = value === "vertex" ? "point" : value;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return Object.freeze(out);
}

function canonicalTags(tags: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function hasLifecyclePrefix(value: string): boolean {
  const prefix = value.split(/[:/]/, 1)[0];
  return (LIFECYCLE_PREFIXES as readonly string[]).includes(prefix ?? "");
}

function freezeRecord(input: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze({ ...input });
}

function buildPresetEntry(
  presetId: string,
  raw: RawEditorPreset,
  deprecatedTagSets: ReadonlySet<string>,
): EditorPresetEntry {
  const tags = raw.tags ?? {};
  const concrete: Record<string, string> = {};
  let hasWildcardTags = false;
  for (const [key, value] of Object.entries(tags)) {
    if (value === "*" || key.endsWith("*")) {
      hasWildcardTags = true;
      continue;
    }
    concrete[key] = value;
  }
  const fieldIds: string[] = [];
  for (const fieldId of [...(raw.fields ?? []), ...(raw.moreFields ?? [])]) {
    if (!fieldIds.includes(fieldId)) fieldIds.push(fieldId);
  }
  const lifecycle =
    hasLifecyclePrefix(presetId) || Object.keys(tags).some((key) => hasLifecyclePrefix(key));

  return Object.freeze({
    presetId,
    tags: freezeRecord(tags),
    concreteTags: freezeRecord(concrete),
    addTags: freezeRecord(raw.addTags ?? {}),
    geometry: normalizeGeometry(raw.geometry),
    searchable: raw.searchable !== false,
    matchScore: raw.matchScore ?? 1,
    icon: raw.icon,
    fieldIds: Object.freeze(fieldIds),
    hasWildcardTags,
    deprecated: deprecatedTagSets.has(canonicalTags(tags)),
    lifecycle,
  });
}

interface RawTranslationBundle {
  presets: Record<string, { name?: string; terms?: string[] | string }>;
  fields: Record<
    string,
    {
      label?: string;
      options?: Record<string, string>;
      labels?: Record<string, string>;
      placeholders?: Record<string, string>;
    }
  >;
}

function readTranslations(lang: EditorLang): RawTranslationBundle {
  try {
    const file = readJson<Record<string, { presets: RawTranslationBundle }>>(
      `@openstreetmap/id-tagging-schema/dist/translations/${lang}.json`,
    );
    const bundle = file[lang]?.presets;
    return { presets: bundle?.presets ?? {}, fields: bundle?.fields ?? {} };
  } catch {
    return { presets: {}, fields: {} };
  }
}

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildIndex(): EditorIndex {
  const rawPresets = readJson<Record<string, RawEditorPreset>>(
    "@openstreetmap/id-tagging-schema/dist/presets.min.json",
  );
  const rawFields = readJson<Record<string, RawEditorField>>(
    "@openstreetmap/id-tagging-schema/dist/fields.min.json",
  );
  const rawDeprecations = readJson<RawDeprecation[]>(
    "@openstreetmap/id-tagging-schema/dist/deprecated.min.json",
  );

  const deprecatedTagSets = new Set(rawDeprecations.map((entry) => canonicalTags(entry.old ?? {})));

  const presets = new Map<string, EditorPresetEntry>();
  for (const [presetId, raw] of Object.entries(rawPresets)) {
    presets.set(presetId, buildPresetEntry(presetId, raw, deprecatedTagSets));
  }

  const fields = new Map<string, EditorFieldEntry>();
  for (const fieldId of EDITOR_FIELD_IDS) {
    const raw = rawFields[fieldId];
    if (!raw) continue;
    const keys = raw.keys ?? (raw.key ? [raw.key] : []);
    fields.set(
      fieldId,
      Object.freeze({
        fieldId,
        keys: Object.freeze([...keys]),
        type: raw.type,
        options: raw.options ? Object.freeze([...raw.options]) : undefined,
      }),
    );
  }

  const text = new Map<EditorLang, ReadonlyMap<string, EditorPresetText>>();
  const fieldLabels = new Map<EditorLang, ReadonlyMap<string, string>>();
  const addressLabels = new Map<EditorLang, ReadonlyMap<string, string>>();
  const optionLabels = new Map<EditorLang, ReadonlyMap<string, string>>();

  const english = readTranslations("en");

  for (const lang of EDITOR_LANGS) {
    const bundle = lang === "en" ? english : readTranslations(lang);

    const langText = new Map<string, EditorPresetText>();
    for (const presetId of presets.keys()) {
      const localized = bundle.presets[presetId] ?? {};
      const fallback = english.presets[presetId] ?? {};
      const name = localized.name ?? fallback.name ?? presetId;
      langText.set(
        presetId,
        Object.freeze({
          name,
          normalizedName: normalize(name),
          normalizedTerms: Object.freeze(tokenizeTerms(localized.terms ?? fallback.terms)),
        }),
      );
    }
    text.set(lang, langText);

    const labels = new Map<string, string>();
    const options = new Map<string, string>();
    const addresses = new Map<string, string>();
    for (const fieldId of fields.keys()) {
      const localized = bundle.fields[fieldId] ?? {};
      const fallback = english.fields[fieldId] ?? {};
      labels.set(fieldId, localized.label ?? fallback.label ?? titleCase(fieldId));
      const localizedOptions = { ...fallback.options, ...localized.options };
      for (const [value, label] of Object.entries(localizedOptions)) {
        options.set(`${fieldId}:${value}`, label);
      }
      if (fieldId === "address") {
        // The schema splits address sub-labels across `labels` (explicit) and
        // `placeholders` (used as a label by iD when no explicit one exists).
        const merged = {
          ...fallback.placeholders,
          ...fallback.labels,
          ...localized.placeholders,
          ...localized.labels,
        };
        for (const [component, label] of Object.entries(merged)) {
          // Country-scoped variants such as `city!jp` are not part of v1.
          if (component.includes("!")) continue;
          addresses.set(component, label);
        }
      }
    }
    fieldLabels.set(lang, labels);
    optionLabels.set(lang, options);
    addressLabels.set(lang, addresses);
  }

  return Object.freeze({
    presets,
    text,
    fields,
    fieldLabels,
    addressLabels,
    optionLabels,
  }) as EditorIndex;
}

let cached: EditorIndex | undefined;

/**
 * Build (once) the immutable editor index. Server/build-side only: it reads the
 * schema JSON from disk and is never re-exported into a browser bundle.
 */
export function loadEditorIndex(): EditorIndex {
  if (!cached) cached = buildIndex();
  return cached;
}

/** Bounded language resolution so an arbitrary locale cannot grow a cache. */
export function resolveEditorLang(lang: string | undefined): EditorLang {
  return lang === "de" ? "de" : "en";
}

export { normalize as normalizeEditorText };
