import type { BrandDetail, BrandKind, BrandSummary } from "@openmapx/core";

/** One catalogued chain, operator, or network — keyed by its Wikidata QID. */
export type BrandEntry = BrandDetail;

/** The committed artifact. `v` guards against loading an incompatible shape. */
export interface BrandArtifact {
  v: 1;
  /** NSI package version the artifact was generated from, e.g. "8.0.20260729". */
  source: string;
  /** Licence of the upstream data. */
  license: string;
  brands: BrandEntry[];
}

/**
 * One ranked autocomplete hit — core's `BrandSummary` plus the score's origin.
 * Matches how core already expresses `BrandSuggestResponse.matches`.
 */
export type BrandMatch = BrandSummary & {
  /** Which field produced the highest score. Useful for UI hints / debugging. */
  matchedOn: "name" | "alias";
};

export type { BrandKind };
