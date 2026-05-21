/** Raw preset entry as it appears in `@openstreetmap/id-tagging-schema/dist/presets.min.json`. */
export interface RawPreset {
  /** OSM tags identifying this feature, e.g. { amenity: "ice_cream" }. May use "*" wildcard values. */
  tags: Record<string, string>;
  /** Tags to add when creating this feature; defaults to `tags` when absent. */
  addTags?: Record<string, string>;
  /** Geometry types this preset applies to. */
  geometry?: Array<"point" | "vertex" | "line" | "area" | "relation">;
  /** Icon key, e.g. "maki-restaurant" or "fas-ice-cream". Some presets have no icon. */
  icon?: string;
  /** Higher = preferred when several presets match the same feature. Defaults to 1. */
  matchScore?: number;
  /** When false, hidden from search. Defaults to true. */
  searchable?: boolean;
}

/** Raw translation entry from `dist/translations/<lang>.json` at path `<lang>.presets.presets[<presetId>]`. */
export interface RawTranslation {
  name?: string;
  /** Comma-separated. */
  terms?: string;
  /**
   * Rare; treated as optional. In practice the iD schema stores this as a
   * newline-separated string, but older spec docs describe it as an array,
   * so the loader accepts both shapes.
   */
  aliases?: string[] | string;
}

/** Pre-normalised, ready-to-score entry held in memory per language. */
export interface PresetIndexEntry {
  presetId: string;
  /** Human-readable display name in the indexed language. */
  displayName: string;
  /** Lowercase, NFD-stripped, trimmed display name. */
  normalizedName: string;
  /** Lowercase, NFD-stripped tokens. */
  normalizedAliases: string[];
  normalizedTerms: string[];
  tags: Record<string, string>;
  /** May be undefined for presets that ship without an icon. */
  icon?: string;
  matchScore: number;
}

export interface PresetMatch {
  /** Slash-separated id, e.g. "amenity/ice_cream". */
  id: string;
  /** Localised display name. */
  name: string;
  /** Icon key as it appears in the iD schema, e.g. "maki-fuel". May be undefined. */
  iconKey?: string;
  tags: Record<string, string>;
  /** Which field produced the highest score. Useful for UI hints / debugging. */
  matchedOn: "name" | "alias" | "term";
}
