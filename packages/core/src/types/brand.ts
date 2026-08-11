/** Which `*:wikidata` OSM key carries this identity. */
export type BrandKind = "brand" | "operator" | "network";

/** Everything the UI needs to render a brand in a list row, a chip, or a pin. */
export interface BrandSummary {
  /** Wikidata QID, e.g. "Q37158". */
  qid: string;
  /** Wikidata label, falling back to the NSI display name. */
  name: string;
  /** Short Wikidata description, e.g. "American coffeehouse chain". */
  description?: string;
  /**
   * Wikimedia Commons *filename* (not a URL), derived by NSI from Wikidata
   * P154; render the URL with `commonsLogoUrl`. Absent for roughly two thirds
   * of entries.
   */
  logoFile?: string;
  /** Every `*:wikidata` key NSI uses for this identity. Never empty. */
  kind: BrandKind[];
}

/** The full catalog record, served by the brand detail route. */
export interface BrandDetail extends BrandSummary {
  /** First official website, when NSI has one. */
  website?: string;
  /** Normalized searchable names: display name, NSI matchNames, tags.name. */
  matchNames: string[];
  /** Lowercase ISO 3166-1 alpha-2 codes from NSI's locationSet.include. */
  countries: string[];
  /** Primary OSM tag sets as "key=value" strings, e.g. ["shop=supermarket"]. */
  tagSets: string[];
  /** Number of NSI items referencing this QID — a chain-size proxy for ranking. */
  itemCount: number;
}

export interface BrandSuggestResponse {
  matches: (BrandSummary & { matchedOn: "name" | "alias" })[];
}
