import type { BoundingBox, LngLat } from "../types/geometry";
import { haversineDistance } from "./coordinates";

/** Mirrors `SearchIntent["sort_by"]` — the orderings an NL query can request. */
export type ResultSort = "relevance" | "distance" | "rating";

/**
 * Minimal shape the result sort needs. `CategoryPlace` and `Place` both satisfy
 * it; `rating` is optional so callers whose results carry no rating fall back to
 * the unchanged order rather than failing to compile.
 */
interface SortablePlace {
  coordinates: LngLat | null | undefined;
  rating?: number;
}

/** Centre of a bounding box as a `[lng, lat]` point. */
export function bboxCenter(bbox: BoundingBox): LngLat {
  return [(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2];
}

export function validResultCoordinates(
  coordinates: LngLat | null | undefined,
): coordinates is LngLat {
  return (
    Array.isArray(coordinates) &&
    coordinates.length === 2 &&
    Number.isFinite(coordinates[0]) &&
    Number.isFinite(coordinates[1]) &&
    coordinates[0] >= -180 &&
    coordinates[0] <= 180 &&
    coordinates[1] >= -90 &&
    coordinates[1] <= 90
  );
}

/**
 * Reorder explore results to honour an NL search `sort_by`:
 * - `distance` — ascending great-circle distance from the supplied reference,
 *   with unknown coordinates last. No-op when the reference is invalid.
 * - `rating` — descending rating, with unrated places sinking to the end. No-op
 *   when no result carries a rating (the current `CategoryPlace` shape has none;
 *   kept generic so a future rating enrichment is honoured automatically).
 * - `relevance`/undefined — the backend's original order.
 *
 * Returns the input array unchanged (same reference) whenever no reordering
 * applies, so callers can use the result directly as a memo value without churn.
 */
export function sortResultsByIntent<T extends SortablePlace>(
  results: T[] | undefined,
  sortBy: ResultSort | undefined,
  reference: LngLat | null,
): T[] | undefined {
  if (!results || !sortBy || sortBy === "relevance") return results;

  if (sortBy === "distance") {
    if (!validResultCoordinates(reference)) return results;
    return results
      .map((place, index) => ({
        place,
        index,
        distance: validResultCoordinates(place.coordinates)
          ? haversineDistance(reference, place.coordinates)
          : Infinity,
      }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .map(({ place }) => place);
  }

  if (sortBy === "rating") {
    if (!results.some((r) => typeof r.rating === "number")) return results;
    return [...results].sort((a, b) => (b.rating ?? -Infinity) - (a.rating ?? -Infinity));
  }

  return results;
}
