import type { TripLeg } from "@openmapx/mobility-core/transit";

/**
 * Decide whether a transit leg's on-map geometry should be refined by a lazy
 * `/leg-geometry` request after the itinerary is selected.
 *
 * Only stop-connected ("coarse") inline geometry benefits from refinement:
 * providers like DB Vendo or Entur return a path that merely joins the leg's
 * stops and expose a separate polyline endpoint to fetch the true shape. MOTIS
 * already embeds the full track polyline in the plan (and also serves
 * leg-geometry lookups), so a detailed MOTIS leg needs no refinement.
 *
 * An already-detailed polyline is detected by comparing the vertex count to a
 * pure stop-connected path (from + intermediate stops + to). When the backend
 * did not report the stop count we default to refining, preserving the prior
 * behaviour for providers that don't populate it.
 */
export function shouldRefineLegGeometry(leg: TripLeg): boolean {
  if (!leg.tripId || leg.mode === "walking") return false;
  const stopCount = leg._intermediateStopCount;
  if (stopCount !== undefined) {
    const stopConnectedVertices = stopCount + 2;
    const vertices = leg.geometry?.coordinates.length ?? 0;
    if (vertices > stopConnectedVertices) return false;
  }
  return true;
}
