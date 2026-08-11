import type { BrandKind } from "@openmapx/core";

/** One catalogued chain, operator, or network — keyed by its Wikidata QID. */
export interface BrandEntry {
  /** Wikidata QID, e.g. "Q37158". */
  qid: string;
  /** Wikidata label, falling back to the NSI display name. */
  name: string;
  /** Short Wikidata description, e.g. "American coffeehouse chain". */
  description?: string;
  /** Every `*:wikidata` key NSI uses for this identity. Never empty. */
  kind: BrandKind[];
  /**
   * Wikimedia Commons *filename* (not a URL) for the logo, derived by NSI from
   * Wikidata P154. Absent for roughly two thirds of entries.
   */
  logoFile?: string;
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

/** The committed artifact. `v` guards against loading an incompatible shape. */
export interface BrandArtifact {
  v: 1;
  /** NSI package version the artifact was generated from, e.g. "8.0.20260729". */
  source: string;
  /** Licence of the upstream data. */
  license: string;
  brands: BrandEntry[];
}

/** One ranked autocomplete hit. Widens core's `BrandSummary` with the score's origin. */
export interface BrandMatch {
  qid: string;
  name: string;
  description?: string;
  logoFile?: string;
  kind: BrandKind[];
  /** Which field produced the highest score. Useful for UI hints / debugging. */
  matchedOn: "name" | "alias";
}

export type { BrandKind };
