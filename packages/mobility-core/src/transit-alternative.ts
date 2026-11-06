import { contributorsForRecords, snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { TransitPlace, TripItinerary, TripLeg } from "./types/transit.js";

/** Stop identity wins when both sides identify a stop; coordinate-only boundaries allow 25 m. */
export function sameTransitPlace(
  a: Pick<TransitPlace, "stopId" | "lat" | "lng">,
  b: Pick<TransitPlace, "stopId" | "lat" | "lng">,
): boolean {
  if (a.stopId && b.stopId) return a.stopId === b.stopId;
  const dy = (a.lat - b.lat) * 111320,
    dx = (a.lng - b.lng) * 111320 * Math.cos(((a.lat + b.lat) * Math.PI) / 360);
  return Number.isFinite(dx + dy) && Math.hypot(dx, dy) <= 25;
}
export function coherentTransitLegs(
  legs: readonly Pick<TripLeg, "from" | "to" | "startTime" | "endTime">[],
): boolean {
  return (
    legs.length > 0 &&
    legs.every((l, i) => {
      const start = Date.parse(l.startTime),
        end = Date.parse(l.endTime),
        previous = legs[i - 1];
      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= end &&
        (!previous ||
          (Date.parse(previous.endTime) <= start && sameTransitPlace(previous.to, l.from)))
      );
    })
  );
}
/** Compose a validated replacement without copying the parent fare, refresh identity or unused credits. */
export function composeTransitAlternative(
  parent: TripItinerary,
  legIndex: number,
  alternativeIndex: number,
): TripItinerary | null {
  const alt = parent.legs[legIndex]?.alternatives?.[alternativeIndex];
  const range = alt?.replaces,
    chain = alt?.legs;
  if (
    !range ||
    !chain?.length ||
    chain.length > 6 ||
    !Number.isInteger(range.fromLegIndex) ||
    !Number.isInteger(range.toLegIndex) ||
    range.fromLegIndex < 0 ||
    range.fromLegIndex > legIndex ||
    range.toLegIndex < legIndex ||
    range.toLegIndex >= parent.legs.length
  )
    return null;
  if (
    !sameTransitPlace(parent.legs[range.fromLegIndex].from, chain[0].from) ||
    !sameTransitPlace(parent.legs[range.toLegIndex].to, chain[chain.length - 1].to)
  )
    return null;
  const legs = [
    ...parent.legs.slice(0, range.fromLegIndex),
    ...chain,
    ...parent.legs.slice(range.toLegIndex + 1),
  ].map((leg) => {
    const {
      alternatives: _alternatives,
      fareTransferIndex: _fareTransfer,
      effectiveFareLegIndex: _fareLeg,
      ...retained
    } = leg as TripLeg;
    return retained;
  });
  if (!coherentTransitLegs(legs) || legs.some((l) => l.cancelled)) return null;
  const startTime = legs[0].startTime,
    endTime = legs[legs.length - 1].endTime;
  const sum = (fn: (leg: TripLeg) => number) => legs.reduce((s, l) => s + fn(l), 0);
  return {
    source: parent.source,
    instance: parent.instance,
    datasetEpoch: parent.datasetEpoch,
    plannedAt: parent.plannedAt,
    startTime,
    endTime,
    duration: (Date.parse(endTime) - Date.parse(startTime)) / 1000,
    transfers: Math.max(0, legs.filter((l) => l.route && !l.interlineWithPrevious).length - 1),
    walkDistance: Math.round(sum((l) => (l.mode === "walking" ? (l.distanceMeters ?? 0) : 0))),
    distanceMeters: sum((l) => l.distanceMeters ?? 0),
    ascentMeters: sum((l) => l.ascentMeters ?? 0),
    descentMeters: sum((l) => l.descentMeters ?? 0),
    regionalOnly: alt.regionalOnly,
    legs,
    contributors: snapshotContributors(contributorsForRecords(legs)),
  };
}
