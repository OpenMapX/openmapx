/**
 * Types for the *editor* view of the iD tagging schema.
 *
 * This is deliberately separate from the search-oriented index in `types.ts`:
 * changing an editor safety rule must never move a place-search result, and
 * search ranking must never make a category editable.
 */

/** Geometries a preset can be matched against. `unknown` is not a valid input. */
export type OsmEditorGeometry = "point" | "line" | "area" | "relation";

/** Raw preset entry from `dist/presets.min.json`, as observed in schema v7. */
export interface RawEditorPreset {
  tags: Record<string, string>;
  addTags?: Record<string, string>;
  removeTags?: Record<string, string>;
  geometry?: Array<"point" | "vertex" | "line" | "area" | "relation">;
  icon?: string;
  matchScore?: number;
  searchable?: boolean;
  fields?: string[];
  moreFields?: string[];
}

/** Raw field entry from `dist/fields.min.json`. */
export interface RawEditorField {
  key?: string;
  keys?: string[];
  type: string;
  options?: string[];
  universal?: boolean;
}

/** Raw entry from `dist/deprecated.min.json` (an array in schema v7). */
export interface RawDeprecation {
  old: Record<string, string>;
  replace?: Record<string, string>;
}

/** Language-neutral editor view of one preset. */
export interface EditorPresetEntry {
  presetId: string;
  /** Identifying tags exactly as the schema declares them, wildcards included. */
  readonly tags: Readonly<Record<string, string>>;
  /** Identifying tags with concrete (non-`*`) values only. */
  readonly concreteTags: Readonly<Record<string, string>>;
  /** Creation-time defaults. Retained for audit; never applied to an existing place. */
  readonly addTags: Readonly<Record<string, string>>;
  readonly geometry: readonly OsmEditorGeometry[];
  searchable: boolean;
  matchScore: number;
  icon?: string;
  /** `fields` + `moreFields`, in declaration order, de-duplicated. */
  readonly fieldIds: readonly string[];
  hasWildcardTags: boolean;
  /** The schema lists this exact tag set under `deprecated.min.json`. */
  deprecated: boolean;
  /** The preset describes a lifecycle state (`disused:`, `demolished:`, …). */
  lifecycle: boolean;
}

export interface EditorPresetText {
  name: string;
  normalizedName: string;
  normalizedTerms: readonly string[];
}

/** Field metadata kept for the v1 allowlist only. */
export interface EditorFieldEntry {
  fieldId: string;
  /** Every OSM key the schema treats as this field, primary first. */
  readonly keys: readonly string[];
  type: string;
  readonly options?: readonly string[];
}

export type EditorLang = "en" | "de";

export interface EditorIndex {
  readonly presets: ReadonlyMap<string, EditorPresetEntry>;
  readonly text: ReadonlyMap<EditorLang, ReadonlyMap<string, EditorPresetText>>;
  readonly fields: ReadonlyMap<string, EditorFieldEntry>;
  readonly fieldLabels: ReadonlyMap<EditorLang, ReadonlyMap<string, string>>;
  /** `addr:*` sub-key labels, keyed by the bare component (`housenumber`). */
  readonly addressLabels: ReadonlyMap<EditorLang, ReadonlyMap<string, string>>;
  /** Choice labels keyed `<fieldId>:<value>`. */
  readonly optionLabels: ReadonlyMap<EditorLang, ReadonlyMap<string, string>>;
}

export interface EditablePresetSummary {
  presetId: string;
  name: string;
  iconKey?: string;
  readonly geometry: readonly OsmEditorGeometry[];
}

export type EditablePresetUnsupportedReason =
  | "WILDCARD_ONLY"
  | "DEPRECATED"
  | "LIFECYCLE"
  | "GEOMETRY"
  | "NO_MATCH";

/**
 * Ambiguity is never collapsed to the first candidate: a tie disables the
 * category field instead of guessing which fact the mapper meant.
 */
export type EditablePresetMatch =
  | { status: "matched"; preset: EditablePresetSummary }
  | { status: "ambiguous"; candidates: readonly EditablePresetSummary[] }
  | { status: "unsupported"; reason: EditablePresetUnsupportedReason };

/** Semantic field names shared with the API contract. */
export type EditableFieldName =
  | "name"
  | "category"
  | "address"
  | "openingHours"
  | "phone"
  | "email"
  | "website"
  | "wheelchair";

export type EditableFieldDisabledReason =
  | "ALIAS_CONFLICT"
  | "NO_ADDRESS_ON_ELEMENT"
  | "GEOMETRY_UNKNOWN"
  | "CATEGORY_AMBIGUOUS"
  | "CATEGORY_UNSUPPORTED"
  | "LIFECYCLE_STATE"
  | "VALUE_TOO_LONG";

export type EditableAddressComponent =
  | "houseNumber"
  | "street"
  | "place"
  | "postcode"
  | "city"
  | "state"
  | "country"
  | "unit"
  | "floor"
  | "door";

export interface EditableAddressEntry {
  component: EditableAddressComponent;
  /** The exact `addr:*` key this component owns on this element. */
  osmKey: string;
  label: string;
  currentValue: string;
}

interface EditableFieldBase {
  field: EditableFieldName;
  label: string;
  enabled: boolean;
  disabledReason?: EditableFieldDisabledReason;
  /** Exact OSM keys the field is allowed to write. Empty when disabled. */
  readonly ownedKeys: readonly string[];
}

export interface EditableTextField extends EditableFieldBase {
  kind: "text";
  field: "name" | "openingHours" | "phone" | "email" | "website";
  currentValue: string | null;
  maxCodePoints: number;
}

export interface EditableChoiceField extends EditableFieldBase {
  kind: "choice";
  field: "wheelchair";
  currentValue: string | null;
  readonly options: ReadonlyArray<{ value: string; label: string }>;
}

export interface EditableCategoryField extends EditableFieldBase {
  kind: "category";
  field: "category";
  currentPresetId: string | null;
  currentPresetName: string | null;
}

export interface EditableAddressField extends EditableFieldBase {
  kind: "address";
  field: "address";
  readonly entries: readonly EditableAddressEntry[];
}

export type EditableFieldDescriptor =
  | EditableTextField
  | EditableChoiceField
  | EditableCategoryField
  | EditableAddressField;

export interface EditableFieldModel {
  geometry: OsmEditorGeometry | "unknown";
  presetMatch: EditablePresetMatch;
  readonly fields: readonly EditableFieldDescriptor[];
}

export interface CategoryTagChange {
  key: string;
  value: string;
}

export interface CategoryTagReplacement {
  key: string;
  from: string;
  to: string;
}

export type CategoryTransitionRejection =
  | "CURRENT_NOT_EDITABLE"
  | "TARGET_UNKNOWN"
  | "TARGET_WILDCARD"
  | "TARGET_DEPRECATED"
  | "TARGET_LIFECYCLE"
  | "TARGET_GEOMETRY"
  | "TARGET_UNSEARCHABLE"
  | "NO_CHANGE"
  | "TOUCHES_UNOWNED_TAG";

export type CategoryTransition =
  | {
      status: "ok";
      target: EditablePresetSummary;
      readonly add: readonly CategoryTagChange[];
      readonly replace: readonly CategoryTagReplacement[];
      readonly remove: readonly CategoryTagChange[];
      /** Every key the transition is permitted to touch. */
      readonly ownedKeys: readonly string[];
    }
  | { status: "rejected"; reason: CategoryTransitionRejection };
