/** Which `*:wikidata` OSM key carries this identity. */
export type BrandKind = "brand" | "operator" | "network";

/** Everything the UI needs to render a brand in a list row, a chip, or a pin. */
export interface BrandSummary {
  qid: string;
  name: string;
  description?: string;
  /** Wikimedia Commons filename; render the URL with `commonsLogoUrl`. */
  logoFile?: string;
  kind: BrandKind[];
}

/** The full catalog record, served by the brand detail route. */
export interface BrandDetail extends BrandSummary {
  website?: string;
  matchNames: string[];
  countries: string[];
  tagSets: string[];
  itemCount: number;
}

export interface BrandSuggestResponse {
  matches: (BrandSummary & { matchedOn: "name" | "alias" })[];
}
