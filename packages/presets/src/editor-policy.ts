import { loadEditorIndex, normalizeEditorText, resolveEditorLang } from "./editor-loader";
import type {
  CategoryTagChange,
  CategoryTagReplacement,
  CategoryTransition,
  EditableAddressComponent,
  EditableAddressEntry,
  EditableFieldDescriptor,
  EditableFieldDisabledReason,
  EditableFieldModel,
  EditablePresetMatch,
  EditablePresetSummary,
  EditorIndex,
  EditorLang,
  EditorPresetEntry,
  OsmEditorGeometry,
} from "./editor-types";

/** OSM limits tag keys and values to 255 Unicode characters. */
const MAX_TAG_CODE_POINTS = 255;
const MAX_QUERY_CODE_POINTS = 100;

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

/**
 * Semantic address component → the single `addr:*` key it owns. Deliberately a
 * closed list: an unlisted component simply is not editable in v1.
 */
const ADDRESS_COMPONENT_KEYS: ReadonlyArray<readonly [EditableAddressComponent, string]> = [
  ["houseNumber", "addr:housenumber"],
  ["street", "addr:street"],
  ["place", "addr:place"],
  ["postcode", "addr:postcode"],
  ["city", "addr:city"],
  ["state", "addr:state"],
  ["country", "addr:country"],
  ["unit", "addr:unit"],
  ["floor", "addr:floor"],
  ["door", "addr:door"],
];

/**
 * Keys a curated field owns. A category transition that would touch one of
 * these is refused: changing a category must never rewrite a contact, name or
 * address fact.
 */
const CURATED_FIELD_KEYS: ReadonlySet<string> = new Set([
  "name",
  "opening_hours",
  "phone",
  "contact:phone",
  "email",
  "contact:email",
  "website",
  "contact:website",
  "wheelchair",
  ...ADDRESS_COMPONENT_KEYS.map(([, key]) => key),
]);

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function hasLifecyclePrefix(key: string): boolean {
  const prefix = key.split(":", 1)[0];
  return (LIFECYCLE_PREFIXES as readonly string[]).includes(prefix ?? "");
}

function summarize(
  entry: EditorPresetEntry,
  index: EditorIndex,
  lang: EditorLang,
): EditablePresetSummary {
  return Object.freeze({
    presetId: entry.presetId,
    name: index.text.get(lang)?.get(entry.presetId)?.name ?? entry.presetId,
    iconKey: entry.icon,
    geometry: entry.geometry,
  });
}

/** Every preset whose concrete identifying tags are all present on the element. */
function concreteCandidates(
  tags: Readonly<Record<string, string>>,
  index: EditorIndex,
): EditorPresetEntry[] {
  const out: EditorPresetEntry[] = [];
  for (const entry of index.presets.values()) {
    const keys = Object.keys(entry.concreteTags);
    if (keys.length === 0) continue;
    if (!keys.every((key) => tags[key] === entry.concreteTags[key])) continue;
    out.push(entry);
  }
  return out;
}

/** True when a wildcard-valued preset would have matched this element. */
function matchesWildcardPreset(
  tags: Readonly<Record<string, string>>,
  index: EditorIndex,
): boolean {
  for (const entry of index.presets.values()) {
    if (!entry.hasWildcardTags) continue;
    const concrete = Object.entries(entry.concreteTags);
    if (!concrete.every(([key, value]) => tags[key] === value)) continue;
    const wildcardKeys = Object.entries(entry.tags)
      .filter(([key, value]) => value === "*" || key.endsWith("*"))
      .map(([key]) => key);
    const matched = wildcardKeys.every((key) =>
      key.endsWith("*")
        ? Object.keys(tags).some((tagKey) => tagKey.startsWith(key.slice(0, -1)))
        : typeof tags[key] === "string",
    );
    if (matched) return true;
  }
  return false;
}

/**
 * Top candidates by identifying specificity, then schema match score. Lexical
 * order only stabilizes output — it is never a semantic tiebreaker.
 */
function topCandidates(candidates: readonly EditorPresetEntry[]): EditorPresetEntry[] {
  if (candidates.length === 0) return [];
  const maxSpecificity = Math.max(
    ...candidates.map((entry) => Object.keys(entry.concreteTags).length),
  );
  const bySpecificity = candidates.filter(
    (entry) => Object.keys(entry.concreteTags).length === maxSpecificity,
  );
  const maxScore = Math.max(...bySpecificity.map((entry) => entry.matchScore));
  return bySpecificity
    .filter((entry) => entry.matchScore === maxScore)
    .sort((a, b) => (a.presetId < b.presetId ? -1 : a.presetId > b.presetId ? 1 : 0));
}

/**
 * Strict, geometry-aware preset match. Ambiguity, wildcards, deprecations,
 * lifecycle states and geometry mismatches all disable direct category editing
 * rather than resolving to a guess.
 */
export function matchEditablePreset(
  tags: Readonly<Record<string, string>>,
  geometry: OsmEditorGeometry,
  lang?: string,
): EditablePresetMatch {
  const index = loadEditorIndex();
  const resolved = resolveEditorLang(lang);

  if (Object.keys(tags).some(hasLifecyclePrefix)) {
    return { status: "unsupported", reason: "LIFECYCLE" };
  }

  const candidates = concreteCandidates(tags, index);
  if (candidates.length === 0) {
    return {
      status: "unsupported",
      reason: matchesWildcardPreset(tags, index) ? "WILDCARD_ONLY" : "NO_MATCH",
    };
  }

  const top = topCandidates(candidates);
  if (top.length > 1) {
    return {
      status: "ambiguous",
      candidates: Object.freeze(top.map((entry) => summarize(entry, index, resolved))),
    };
  }

  const best = top[0];
  if (!best) return { status: "unsupported", reason: "NO_MATCH" };
  if (best.lifecycle) return { status: "unsupported", reason: "LIFECYCLE" };
  if (best.deprecated) return { status: "unsupported", reason: "DEPRECATED" };
  if (!best.geometry.includes(geometry)) {
    return { status: "unsupported", reason: "GEOMETRY" };
  }
  return { status: "matched", preset: summarize(best, index, resolved) };
}

function isSuggestableTarget(entry: EditorPresetEntry, geometry: OsmEditorGeometry): boolean {
  return (
    entry.searchable &&
    !entry.deprecated &&
    !entry.lifecycle &&
    !entry.hasWildcardTags &&
    Object.keys(entry.concreteTags).length > 0 &&
    entry.geometry.includes(geometry) &&
    !Object.keys(entry.concreteTags).some((key) => CURATED_FIELD_KEYS.has(key))
  );
}

function scoreQuery(
  normalizedName: string,
  normalizedTerms: readonly string[],
  query: string,
  matchScore: number,
): number | undefined {
  if (normalizedName === query) return 1000 * matchScore;
  if (normalizedName.startsWith(query)) return 500 * matchScore;
  if (normalizedName.includes(query)) return 250 * matchScore;
  if (normalizedTerms.includes(query)) return 100 * matchScore;
  if (normalizedTerms.some((term) => term.startsWith(query))) return 50 * matchScore;
  return undefined;
}

/**
 * Bounded localized search over *editable* targets only. Distinct from
 * `suggestPresets()`, whose ranking serves place search and must not change
 * when an editor safety rule does.
 */
export function suggestEditablePresets(input: {
  query: string;
  geometry: OsmEditorGeometry;
  lang?: string;
  limit?: number;
}): EditablePresetSummary[] {
  const query = normalizeEditorText(input.query);
  if (query.length === 0 || countCodePoints(query) > MAX_QUERY_CODE_POINTS) return [];
  const requested = input.limit === undefined ? 10 : Math.trunc(input.limit);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 20) : 10;

  const index = loadEditorIndex();
  const lang = resolveEditorLang(input.lang);
  const text = index.text.get(lang);

  const hits: Array<{ entry: EditorPresetEntry; score: number }> = [];
  for (const entry of index.presets.values()) {
    if (!isSuggestableTarget(entry, input.geometry)) continue;
    const localized = text?.get(entry.presetId);
    if (!localized) continue;
    const score = scoreQuery(
      localized.normalizedName,
      localized.normalizedTerms,
      query,
      entry.matchScore,
    );
    if (score === undefined) continue;
    hits.push({ entry, score });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.presetId < b.entry.presetId ? -1 : a.entry.presetId > b.entry.presetId ? 1 : 0),
  );

  return hits.slice(0, limit).map((hit) => summarize(hit.entry, index, lang));
}

export function getEditablePreset(
  presetId: string,
  geometry: OsmEditorGeometry,
  lang?: string,
): EditablePresetSummary | undefined {
  const index = loadEditorIndex();
  const entry = index.presets.get(presetId);
  if (!entry || !isSuggestableTarget(entry, geometry)) return undefined;
  return summarize(entry, index, resolveEditorLang(lang));
}

/**
 * Geometry for a way. A closed way is *not* evidence of an area: only explicit
 * `area` tagging or an unambiguous geometry-neutral preset match decides.
 */
export function inferEditableWayGeometry(
  tags: Readonly<Record<string, string>>,
  isClosed: boolean,
  _lang?: string,
): "line" | "area" | "unknown" {
  if (!isClosed) return "line";
  if (tags.area === "yes") return "area";
  if (tags.area === "no") return "line";

  const index = loadEditorIndex();
  const top = topCandidates(concreteCandidates(tags, index));
  if (top.length === 0) return "unknown";

  const supportsArea = top.every((entry) => entry.geometry.includes("area"));
  const supportsLine = top.every((entry) => entry.geometry.includes("line"));
  const anyArea = top.some((entry) => entry.geometry.includes("area"));
  const anyLine = top.some((entry) => entry.geometry.includes("line"));

  if (supportsArea && !anyLine) return "area";
  if (supportsLine && !anyArea) return "line";
  return "unknown";
}

function textField(
  field: "name" | "openingHours" | "phone" | "email" | "website",
  label: string,
  ownedKey: string | null,
  currentValue: string | null,
  disabledReason: EditableFieldDisabledReason | undefined,
): EditableFieldDescriptor {
  const tooLong = currentValue !== null && countCodePoints(currentValue) > MAX_TAG_CODE_POINTS;
  const reason = disabledReason ?? (tooLong ? "VALUE_TOO_LONG" : undefined);
  const enabled = reason === undefined && ownedKey !== null;
  return Object.freeze({
    kind: "text" as const,
    field,
    label,
    currentValue,
    maxCodePoints: MAX_TAG_CODE_POINTS,
    enabled,
    disabledReason: reason,
    ownedKeys: Object.freeze(enabled && ownedKey ? [ownedKey] : []),
  });
}

/** Resolve which alias key a contact field owns, if unambiguous. */
function resolveAliasKey(
  tags: Readonly<Record<string, string>>,
  keys: readonly string[],
): { key: string | null; conflict: boolean } {
  const present = keys.filter((key) => typeof tags[key] === "string");
  if (present.length > 1) return { key: null, conflict: true };
  if (present.length === 1) return { key: present[0] ?? null, conflict: false };
  return { key: keys[0] ?? null, conflict: false };
}

function categoryDisabledReason(
  match: EditablePresetMatch,
  geometry: OsmEditorGeometry | "unknown",
): EditableFieldDisabledReason | undefined {
  if (geometry === "unknown") return "GEOMETRY_UNKNOWN";
  if (match.status === "matched") return undefined;
  if (match.status === "ambiguous") return "CATEGORY_AMBIGUOUS";
  return match.reason === "LIFECYCLE" ? "LIFECYCLE_STATE" : "CATEGORY_UNSUPPORTED";
}

/**
 * The curated v1 field model for one live element. Values come only from the
 * supplied live tag object — never from merged or enriched place data.
 */
export function buildEditableFieldModel(input: {
  tags: Readonly<Record<string, string>>;
  geometry: OsmEditorGeometry | "unknown";
  lang?: string;
}): EditableFieldModel {
  const index = loadEditorIndex();
  const lang = resolveEditorLang(input.lang);
  const labels = index.fieldLabels.get(lang);
  const optionLabels = index.optionLabels.get(lang);
  const addressLabels = index.addressLabels.get(lang);
  const tags = input.tags;

  const presetMatch: EditablePresetMatch =
    input.geometry === "unknown"
      ? { status: "unsupported", reason: "GEOMETRY" }
      : matchEditablePreset(tags, input.geometry, lang);

  const fields: EditableFieldDescriptor[] = [];

  fields.push(
    textField("name", labels?.get("name") ?? "Name", "name", tags.name ?? null, undefined),
  );

  const categoryReason = categoryDisabledReason(presetMatch, input.geometry);
  const categoryEnabled = categoryReason === undefined && presetMatch.status === "matched";
  const currentPreset = presetMatch.status === "matched" ? presetMatch.preset : null;
  const currentEntry = currentPreset ? index.presets.get(currentPreset.presetId) : undefined;
  fields.push(
    Object.freeze({
      kind: "category" as const,
      field: "category" as const,
      label: labels?.get("category") ?? "Category",
      currentPresetId: currentPreset?.presetId ?? null,
      currentPresetName: currentPreset?.name ?? null,
      enabled: categoryEnabled,
      disabledReason: categoryReason,
      ownedKeys: Object.freeze(
        categoryEnabled && currentEntry ? Object.keys(currentEntry.concreteTags).sort() : [],
      ),
    }),
  );

  const addressEntries: EditableAddressEntry[] = [];
  for (const [component, osmKey] of ADDRESS_COMPONENT_KEYS) {
    const value = tags[osmKey];
    if (typeof value !== "string") continue;
    addressEntries.push(
      Object.freeze({
        component,
        osmKey,
        label: addressLabels?.get(osmKey.slice("addr:".length)) ?? component,
        currentValue: value,
      }),
    );
  }
  addressEntries.sort((a, b) => (a.osmKey < b.osmKey ? -1 : a.osmKey > b.osmKey ? 1 : 0));
  const addressEnabled = addressEntries.length > 0;
  fields.push(
    Object.freeze({
      kind: "address" as const,
      field: "address" as const,
      label: labels?.get("address") ?? "Address",
      entries: Object.freeze(addressEntries),
      enabled: addressEnabled,
      disabledReason: addressEnabled ? undefined : ("NO_ADDRESS_ON_ELEMENT" as const),
      ownedKeys: Object.freeze(addressEnabled ? addressEntries.map((e) => e.osmKey) : []),
    }),
  );

  fields.push(
    textField(
      "openingHours",
      labels?.get("opening_hours") ?? "Hours",
      "opening_hours",
      tags.opening_hours ?? null,
      undefined,
    ),
  );

  for (const [field, fieldId] of [
    ["phone", "phone"],
    ["email", "email"],
    ["website", "website"],
  ] as const) {
    const schemaField = index.fields.get(fieldId);
    const { key, conflict } = resolveAliasKey(tags, schemaField?.keys ?? [fieldId]);
    fields.push(
      textField(
        field,
        labels?.get(fieldId) ?? fieldId,
        conflict ? null : key,
        conflict || !key ? null : (tags[key] ?? null),
        conflict ? "ALIAS_CONFLICT" : undefined,
      ),
    );
  }

  const wheelchairField = index.fields.get("wheelchair");
  const wheelchairCurrent = tags.wheelchair ?? null;
  const wheelchairTooLong =
    wheelchairCurrent !== null && countCodePoints(wheelchairCurrent) > MAX_TAG_CODE_POINTS;
  fields.push(
    Object.freeze({
      kind: "choice" as const,
      field: "wheelchair" as const,
      label: labels?.get("wheelchair") ?? "Wheelchair Access",
      currentValue: wheelchairCurrent,
      options: Object.freeze(
        (wheelchairField?.options ?? []).map((value) =>
          Object.freeze({
            value,
            label: optionLabels?.get(`wheelchair:${value}`) ?? value,
          }),
        ),
      ),
      enabled: !wheelchairTooLong,
      disabledReason: wheelchairTooLong ? ("VALUE_TOO_LONG" as const) : undefined,
      ownedKeys: Object.freeze(wheelchairTooLong ? [] : ["wheelchair"]),
    }),
  );

  return Object.freeze({
    geometry: input.geometry,
    presetMatch,
    fields: Object.freeze(fields),
  });
}

/**
 * The exact tag consequence of one category change.
 *
 * Only the old preset's concrete identifying tags may be removed and only the
 * target's concrete identifying tags applied. `addTags` (creation-time schema
 * defaults) are deliberately not applied to an existing place — they would
 * assert facts the contributor never claimed.
 */
export function previewCategoryTransition(input: {
  tags: Readonly<Record<string, string>>;
  current: EditablePresetMatch;
  targetPresetId: string;
  geometry: OsmEditorGeometry;
  lang?: string;
}): CategoryTransition {
  if (input.current.status !== "matched") {
    return { status: "rejected", reason: "CURRENT_NOT_EDITABLE" };
  }
  const index = loadEditorIndex();
  const lang = resolveEditorLang(input.lang);
  const target = index.presets.get(input.targetPresetId);
  if (!target) return { status: "rejected", reason: "TARGET_UNKNOWN" };
  if (target.lifecycle) return { status: "rejected", reason: "TARGET_LIFECYCLE" };
  if (target.deprecated) return { status: "rejected", reason: "TARGET_DEPRECATED" };
  if (target.hasWildcardTags || Object.keys(target.concreteTags).length === 0) {
    return { status: "rejected", reason: "TARGET_WILDCARD" };
  }
  if (!target.searchable) return { status: "rejected", reason: "TARGET_UNSEARCHABLE" };
  if (!target.geometry.includes(input.geometry)) {
    return { status: "rejected", reason: "TARGET_GEOMETRY" };
  }

  const currentEntry = index.presets.get(input.current.preset.presetId);
  if (!currentEntry) return { status: "rejected", reason: "CURRENT_NOT_EDITABLE" };
  if (currentEntry.presetId === target.presetId) {
    return { status: "rejected", reason: "NO_CHANGE" };
  }

  const ownedKeys = [
    ...new Set([...Object.keys(currentEntry.concreteTags), ...Object.keys(target.concreteTags)]),
  ].sort();
  if (ownedKeys.some((key) => CURATED_FIELD_KEYS.has(key))) {
    return { status: "rejected", reason: "TOUCHES_UNOWNED_TAG" };
  }

  const add: CategoryTagChange[] = [];
  const replace: CategoryTagReplacement[] = [];
  const remove: CategoryTagChange[] = [];

  for (const key of ownedKeys) {
    const targetValue = target.concreteTags[key];
    const liveValue = input.tags[key];
    if (targetValue === undefined) {
      // Defining tag of the old preset that the target does not use.
      if (typeof liveValue === "string") remove.push({ key, value: liveValue });
      continue;
    }
    if (liveValue === undefined) {
      add.push({ key, value: targetValue });
      continue;
    }
    if (liveValue !== targetValue) replace.push({ key, from: liveValue, to: targetValue });
  }

  if (add.length === 0 && replace.length === 0 && remove.length === 0) {
    return { status: "rejected", reason: "NO_CHANGE" };
  }

  return Object.freeze({
    status: "ok" as const,
    target: summarize(target, index, lang),
    add: Object.freeze(add),
    replace: Object.freeze(replace),
    remove: Object.freeze(remove),
    ownedKeys: Object.freeze(ownedKeys),
  });
}

export { ADDRESS_COMPONENT_KEYS, CURATED_FIELD_KEYS };
