import type { TransitLegCapture } from "./mobileProtocol";

/**
 * Capturing the stop sequence a transit leg actually rides, so guidance can
 * continue without a network connection.
 *
 * A live vehicle journey lists every stop on the line; a leg rides a slice of
 * it. Storing the whole journey would waste space and, worse, let the engine
 * reason about stops the traveller never passes.
 */

/** Minimal stop shape these helpers need, satisfied by the transit wire types. */
export interface JourneyStopLike {
  stopId: string;
  name?: string;
  lat?: number;
  lng?: number;
  platform?: string;
  scheduledPlatform?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  expectedArrival?: string;
  expectedDeparture?: string;
  canceled?: boolean;
  departed?: boolean;
}

/**
 * Slices a full vehicle journey's stop list down to the segment a single leg
 * rides — board stop through alight stop, inclusive.
 *
 * On a circular route (Ringlinie) a stop id can appear more than once, so the
 * alight stop is always matched *after* the board stop. Falls back to the whole
 * list when the endpoints cannot be located, because a shorter-but-wrong slice
 * would be worse than a longer correct one.
 */
export function sliceJourneyToLeg<T extends { stopId: string }>(
  stops: T[],
  fromStopId?: string,
  toStopId?: string,
): T[] {
  const fromIdx = fromStopId ? stops.findIndex((s) => s.stopId === fromStopId) : -1;
  const toIdx =
    fromIdx !== -1 && toStopId
      ? stops.findIndex((s, i) => i > fromIdx && s.stopId === toStopId)
      : toStopId
        ? stops.findIndex((s) => s.stopId === toStopId)
        : -1;
  return fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx
    ? stops.slice(fromIdx, toIdx + 1)
    : stops;
}

/** A leg as `captureTransitLegStops` needs to see it. */
export interface CapturableLeg {
  /** Present only on transit legs; walking legs have none and are skipped. */
  tripId?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  from?: { stopId?: string };
  to?: { stopId?: string };
}

const MAX_CAPTURED_STOPS = 2_000;

function copyStop(stop: JourneyStopLike) {
  // Only the fields navigation needs. Journey formation, remarks and provider
  // metadata are deliberately dropped.
  return {
    stopId: stop.stopId,
    name: stop.name ?? "",
    lat: stop.lat ?? 0,
    lng: stop.lng ?? 0,
    ...(stop.platform !== undefined && { platform: stop.platform }),
    ...(stop.scheduledPlatform !== undefined && { scheduledPlatform: stop.scheduledPlatform }),
    ...(stop.scheduledArrival !== undefined && { scheduledArrival: stop.scheduledArrival }),
    ...(stop.scheduledDeparture !== undefined && { scheduledDeparture: stop.scheduledDeparture }),
    ...(stop.expectedArrival !== undefined && { expectedArrival: stop.expectedArrival }),
    ...(stop.expectedDeparture !== undefined && { expectedDeparture: stop.expectedDeparture }),
    ...(stop.canceled !== undefined && { canceled: stop.canceled }),
    ...(stop.departed !== undefined && { departed: stop.departed }),
  };
}

function hasUsableCoordinates(stop: JourneyStopLike): boolean {
  return (
    typeof stop.lat === "number" &&
    Number.isFinite(stop.lat) &&
    Math.abs(stop.lat) <= 90 &&
    typeof stop.lng === "number" &&
    Number.isFinite(stop.lng) &&
    Math.abs(stop.lng) <= 180
  );
}

/**
 * Builds one capture per ridden transit leg.
 *
 * A leg whose journey could not be fetched produces an explicit `missing`
 * capture rather than fabricated stops — the engine then falls back to the
 * itinerary's own endpoints and times, and says so.
 */
export function captureTransitLegStops(
  legs: readonly CapturableLeg[],
  journeysByTripId: Readonly<Record<string, readonly JourneyStopLike[] | undefined>>,
  capturedAtMs: number,
): TransitLegCapture[] {
  const captures: TransitLegCapture[] = [];
  legs.forEach((leg, legIndex) => {
    // Walking legs have no trip to capture.
    if (!leg.tripId) return;

    const journey = journeysByTripId[leg.tripId];
    if (!journey || journey.length === 0) {
      captures.push({
        legIndex,
        tripId: leg.tripId,
        capturedAtMs,
        status: "missing",
        stops: [],
      });
      return;
    }

    const valid = journey.filter(hasUsableCoordinates);
    const from = matchingOccurrence(
      valid,
      leg.from?.stopId,
      0,
      leg.scheduledStartTime,
      "scheduledDeparture",
    );
    const to = matchingOccurrence(
      valid,
      leg.to?.stopId,
      from + 1,
      leg.scheduledEndTime,
      "scheduledArrival",
    );
    const sliced =
      from >= 0 && to > from && to - from < MAX_CAPTURED_STOPS ? valid.slice(from, to + 1) : [];

    captures.push({
      legIndex,
      tripId: leg.tripId,
      capturedAtMs,
      status: sliced.length > 0 ? "captured" : "missing",
      stops: sliced.map(copyStop),
    });
  });
  return captures;
}

/** Refresh predictions without changing which stop occurrences the rider is following. */
export function refreshTransitCaptures(
  captures: readonly TransitLegCapture[],
  legs: readonly CapturableLeg[],
  journeys: Readonly<Record<string, readonly JourneyStopLike[] | undefined>>,
  nowMs: number,
): TransitLegCapture[] {
  const updates = captureTransitLegStops(legs, journeys, nowMs);
  return captures.map((capture) => {
    const next = updates.find(
      (c) =>
        c.legIndex === capture.legIndex && c.tripId === capture.tripId && c.status === "captured",
    );
    if (capture.status === "missing" && next) return next;
    if (
      capture.status !== "captured" ||
      !next ||
      next.stops.length !== capture.stops.length ||
      next.stops.some((stop, i) => stop.stopId !== capture.stops[i].stopId)
    )
      return capture;
    return {
      ...capture,
      capturedAtMs: nowMs,
      stops: capture.stops.map((stop, i) => {
        const {
          expectedArrival: _arrival,
          expectedDeparture: _departure,
          platform: _platform,
          canceled: _cancelled,
          departed: _departed,
          ...stable
        } = stop;
        const fresh = next.stops[i];
        return {
          ...stable,
          expectedArrival: fresh.expectedArrival,
          expectedDeparture: fresh.expectedDeparture,
          platform: fresh.platform ?? stop.scheduledPlatform,
          scheduledPlatform: fresh.scheduledPlatform ?? stop.scheduledPlatform,
          canceled: fresh.canceled,
          departed: fresh.departed,
        };
      }),
    };
  });
}

/** Scheduled timestamps identify a particular visit on loop services; predictions never choose it. */
function matchingOccurrence(
  stops: JourneyStopLike[],
  id: string | undefined,
  start: number,
  time: string | undefined,
  field: "scheduledDeparture" | "scheduledArrival",
): number {
  const candidates = stops.flatMap((stop, i) => (i >= start && stop.stopId === id ? [i] : []));
  if (candidates.length < 2 || !time || !Number.isFinite(Date.parse(time)))
    return candidates[0] ?? -1;
  const timestamp = Date.parse(time);
  const exact = candidates.find((i) => Date.parse(stops[i][field] ?? "") === timestamp);
  // Ambiguous occurrence identity is unavailable, rather than a different lap.
  return exact ?? -1;
}
