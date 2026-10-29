import type { BrandDetail, BrandKind, BrandPresence, BrandSummary } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";

/** One catalogued chain, operator, or network — keyed by its Wikidata QID. */
export type BrandEntry = BrandDetail;

/** The committed artifact. `v` guards against loading an incompatible shape. */
export interface BrandArtifact {
  v: 2;
  inputHashes: { nsi: string; wikidata: string };
  sourceCredits: Attribution[];
  /** NSI package version the artifact was generated from, e.g. "8.0.20260729". */
  source: string;
  /** Licence of the upstream data. */
  license: string;
  brands: Array<BrandEntry & { origins: Record<string, string[]> }>;
}

/**
 * One ranked autocomplete hit — core's `BrandSummary` plus the score's origin.
 * Matches how core already expresses `BrandSuggestResponse.matches`.
 */
export type BrandMatch = BrandSummary & {
  /** Which field produced the highest score. Useful for UI hints / debugging. */
  matchedOn: "name" | "alias";
  /** Full winning name/alias, never just the query fragment. */
  matchedValue: string;
  /** Where the chain operates relative to the country searched from. */
  presence: BrandPresence;
};

export type { BrandKind };
