/**
 * Generic identity shape for domain items that carry multiple external IDs.
 *
 * A thing in the world (a place, a transit stop, a shared-mobility vehicle)
 * typically has several identifiers — OSM node ref, Wikidata Q-id, Yelp
 * business id, EVA station number, a provider-specific stop id, and so on.
 * `Identified` bundles them into one map and exposes a single stable `id`
 * string so React keys, cache keys, URL params, and dedup logic have a
 * deterministic handle without needing to know which scheme happens to be
 * primary for a given item.
 *
 * The primary scheme is chosen by the *producer* (the code that first
 * constructs the item), not by a global priority list — each source knows
 * what's authoritative for its own data. Downstream enrichment layers can
 * add more schemes to `ids` but they never rewrite `primaryScheme`.
 */

/**
 * Map of scheme → id value for a single item. The scheme is the name of the
 * external system the id belongs to (`osm`, `wikidata`, `yelp`, `eva`, a
 * provider id like `ocm` or `tfl`, etc.). Values are opaque strings in
 * whatever format the scheme's system uses (`node/12345`, `Q4176`, …).
 */
import type { Ids } from "@openmapx/mobility-core/identified";

export type { Ids } from "@openmapx/mobility-core/identified";

/**
 * An item with at least one external identifier. Consumers should use the
 * `{@link makeId}`/`{@link withId}` helpers rather than setting `id` by hand
 * so the derivation stays consistent.
 */
export interface Identified {
  /** Memoized `${primaryScheme}:${ids[primaryScheme]}`. */
  id: string;
  /** Which scheme in `ids` is canonical for this item. */
  primaryScheme: string;
  /** All known identifiers. Must contain `primaryScheme` as a key. */
  ids: Ids;
}

/**
 * Build the canonical `scheme:value` string for the given primary scheme.
 * Throws if the scheme isn't present in the id map — producers must always
 * populate the primary first.
 */
export function makeId(primaryScheme: string, ids: Ids): string {
  const value = ids[primaryScheme];
  if (!value) {
    throw new Error(
      `Identified.ids is missing its primary scheme "${primaryScheme}" — ` +
        `producers must populate the primary id before calling makeId().`,
    );
  }
  return `${primaryScheme}:${value}`;
}

/**
 * Parse a canonical `scheme:value` string back into its parts. Returns
 * `null` for empty, malformed, or prefix-only strings. The scheme must be
 * a non-empty token ending at the first `:`; the value is everything after
 * (which can itself contain colons, e.g. `osm:node/123` or
 * `rdw:manager/area`).
 */
export function parseId(s: string | undefined | null): { scheme: string; value: string } | null {
  if (!s) return null;
  const idx = s.indexOf(":");
  if (idx <= 0 || idx === s.length - 1) return null;
  const scheme = s.slice(0, idx);
  const value = s.slice(idx + 1);
  if (!scheme || !value) return null;
  return { scheme, value };
}

/**
 * Construct an `Identified`-shaped value by deriving `id` from
 * `primaryScheme` + `ids`. Accepts any type whose `Omit<T, "id">` matches
 * the identity shape, so domain types (`Place`, `TransitStop`, …) that
 * extend `Identified` can be built with one call:
 *
 * ```ts
 * const place: Place = withId({ primaryScheme: "osm", ids: { osm: "node/1" }, ... });
 * ```
 */
export function withId<T extends { primaryScheme: string; ids: Ids }>(
  item: Omit<T, "id">,
): T & { id: string } {
  return { ...item, id: makeId(item.primaryScheme, item.ids) } as T & { id: string };
}
