/**
 * Wire shapes for the preset matcher's responses, including older responses
 * without match evidence. Kept local so that core
 * doesn't depend on presets (which itself depends on core).
 */

export interface PresetMatch {
  /** Slash-separated id, e.g. "amenity/ice_cream". */
  id: string;
  /** Localised display name. */
  name: string;
  /** Icon key as it appears in the iD schema, e.g. "maki-fuel". May be undefined. */
  iconKey?: string;
  tags: Record<string, string>;
  /** Which field produced the highest score. */
  matchedOn: "name" | "alias" | "term";
  /** Actual winning name/alias/term. Optional for older servers and cached responses. */
  matchedValue?: string;
}

export interface ChipTranslation {
  /** Localised display name. Empty when no preset matches the chip's tag-set. */
  name: string;
  /** Localised search terms (already lower-cased + diacritic-stripped). */
  terms: string[];
}
