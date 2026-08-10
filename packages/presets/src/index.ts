import { buildChipOverlapSet } from "./chip-overlap";
import { buildChipTranslations, type ChipTranslation } from "./chip-translations";
import { loadPresetIndex } from "./loader";
import { searchPresets } from "./matcher";
import type { PresetIndexEntry, PresetMatch } from "./types";

/** Languages whose translations we ship in the API. Extend when adding UI locales. */
const ENABLED_LANGS = ["en", "de"] as const;
type EnabledLang = (typeof ENABLED_LANGS)[number];

function resolveLang(lang: string | undefined): EnabledLang {
  return lang && (ENABLED_LANGS as readonly string[]).includes(lang) ? (lang as EnabledLang) : "en";
}

let cachedIndex: ReturnType<typeof loadPresetIndex> | undefined;
let cachedPresetMap: Map<string, PresetIndexEntry> | undefined;
let cachedSuppress: Set<string> | undefined;

function getIndex() {
  if (!cachedIndex) cachedIndex = loadPresetIndex(ENABLED_LANGS);
  return cachedIndex;
}

function getPresetMap(): Map<string, PresetIndexEntry> {
  if (!cachedPresetMap) {
    const enSlice = getIndex().get("en") ?? [];
    cachedPresetMap = new Map(enSlice.map((e) => [e.presetId, e]));
  }
  return cachedPresetMap;
}

function getSuppress() {
  if (!cachedSuppress) cachedSuppress = buildChipOverlapSet();
  return cachedSuppress;
}

export function suggestPresets(q: string, lang: string | undefined, limit: number): PresetMatch[] {
  return searchPresets(getIndex(), {
    q,
    lang: resolveLang(lang),
    limit: Math.min(Math.max(limit, 1), 20),
    suppressTagSets: getSuppress(),
  });
}

export function getPresetById(presetId: string): { tags: Record<string, string> } | undefined {
  const entry = getPresetMap().get(presetId);
  return entry ? { tags: entry.tags } : undefined;
}

// Bounded by ENABLED_LANGS — keys are the narrowed `EnabledLang` type, so the
// cache cannot grow unbounded even if upstream callers pass arbitrary strings.
const cachedChipTranslations = new Map<EnabledLang, Record<string, ChipTranslation>>();

export function getChipTranslations(lang: string | undefined): Record<string, ChipTranslation> {
  const lookupLang = resolveLang(lang);
  const cached = cachedChipTranslations.get(lookupLang);
  if (cached) return cached;
  const slice = getIndex().get(lookupLang) ?? getIndex().get("en") ?? [];
  const result = buildChipTranslations(slice);
  cachedChipTranslations.set(lookupLang, result);
  return result;
}

export type { ChipTranslation } from "./chip-translations";
// Curated OSM editor policy. Kept deliberately separate from the search API
// above: an editor safety rule must never move a place-search result.
export {
  EDITOR_FIELD_IDS,
  EDITOR_LANGS,
  loadEditorIndex,
  resolveEditorLang,
} from "./editor-loader";
export {
  ADDRESS_COMPONENT_KEYS,
  buildEditableFieldModel,
  CURATED_FIELD_KEYS,
  getEditablePreset,
  inferEditableWayGeometry,
  matchEditablePreset,
  previewCategoryTransition,
  suggestEditablePresets,
} from "./editor-policy";
export type {
  CategoryTagChange,
  CategoryTagReplacement,
  CategoryTransition,
  CategoryTransitionRejection,
  EditableAddressComponent,
  EditableAddressEntry,
  EditableAddressField,
  EditableCategoryField,
  EditableChoiceField,
  EditableFieldDescriptor,
  EditableFieldDisabledReason,
  EditableFieldModel,
  EditableFieldName,
  EditablePresetMatch,
  EditablePresetSummary,
  EditablePresetUnsupportedReason,
  EditableTextField,
  EditorFieldEntry,
  EditorIndex,
  EditorLang,
  EditorPresetEntry,
  EditorPresetText,
  OsmEditorGeometry,
} from "./editor-types";
export type { PresetMatch } from "./types";
