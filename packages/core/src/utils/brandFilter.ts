import type { BrandKind, BrandSummary } from "../types/brand";
import type { OverpassFilter } from "./overpassFilter";

/** Every OSM key that can carry a brand identity, in precedence order. */
export const BRAND_QID_KEYS = ["brand:wikidata", "network:wikidata", "operator:wikidata"] as const;

const KIND_TO_KEY: Record<BrandKind, string> = {
  brand: "brand:wikidata",
  network: "network:wikidata",
  operator: "operator:wikidata",
};

const BRAND_QID_PATTERN = /^Q\d{1,12}$/;

// Each entry in BRAND_QID_KEYS is `${kind}:wikidata` — deriving the kind this
// way keeps it tied to the key without a second hand-maintained mapping.
function keyToBrandKind(key: string): BrandKind {
  return key.slice(0, key.indexOf(":")) as BrandKind;
}

/**
 * Finds a POI's brand identity by walking {@link BRAND_QID_KEYS} in
 * precedence order and returning the first present, well-formed QID and
 * which key carried it. The single definition of "which tag wins" — every
 * consumer that needs to answer "what brand is this place" (map markers,
 * facet chips, …) goes through this so they never disagree.
 */
export function firstBrandIdentity(
  osmTags: Record<string, string> | undefined,
): { qid: string; kind: BrandKind } | undefined {
  if (!osmTags) return undefined;
  for (const key of BRAND_QID_KEYS) {
    const value = osmTags[key];
    if (value && BRAND_QID_PATTERN.test(value)) return { qid: value, kind: keyToBrandKind(key) };
  }
  return undefined;
}

/**
 * Compiles a brand to a POI filter.
 *
 * One selector per kind: selectors are ORed while the tags inside a selector are
 * ANDed, and a chain tagged `brand:wikidata` on its shops but `operator:wikidata`
 * on its fuel stations has to match either.
 */
export function brandToFilter(brand: Pick<BrandSummary, "qid" | "kind">): OverpassFilter {
  const keys = (brand.kind.length > 0 ? brand.kind : (["brand"] as BrandKind[]))
    .map((k) => KIND_TO_KEY[k])
    .sort();
  return {
    selectors: keys.map((key) => ({
      tags: [{ key, op: "=" as const, value: brand.qid }],
    })),
  };
}

/**
 * Builds a Wikimedia Commons render URL for a logo filename.
 *
 * `Special:FilePath` rasterizes SVGs when `width` is set, so callers get a
 * bitmap they can hand to MapLibre's `addImage` without rasterizing SVG
 * themselves. Always proxy the result before it reaches a browser — see
 * `proxyImageUrl`.
 */
export function commonsLogoUrl(logoFile: string, width = 64): string {
  const encoded = encodeURIComponent(logoFile.replace(/ /g, "_")).replace(/_/g, "%20");
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=${width}`;
}
