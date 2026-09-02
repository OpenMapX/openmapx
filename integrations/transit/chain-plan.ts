import type { ChainedTripPlan, ChainedTripSegment, ChainPlanWarning } from "@openmapx/core";
import {
  fidelityFor,
  planScheduledTrip,
  requiredTemporalSemantics,
  resolveScheduleConstraints,
  type ScheduleAnchor,
  type TemporalCapabilities,
  type WaypointSchedule,
  worstSupport,
} from "@openmapx/core";
import type { TripPlanRequest } from "@openmapx/integration-framework";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { TripItinerary, TripPlan } from "@openmapx/mobility-core/transit";

export interface PlanTransitChainArgs {
  waypoints: { lat: number; lng: number }[];
  schedules: (WaypointSchedule | null)[];
  anchor: ScheduleAnchor;
  /** Everything the caller wants on every segment: modes, wheelchair, buffers. */
  baseRequest: Omit<TripPlanRequest, "from" | "to" | "departureTime" | "arrivalTime">;
  planTrip: (request: TripPlanRequest) => Promise<MobilityResult<TripPlan | null>>;
  capabilities: TemporalCapabilities;
  numItinerariesPerSegment?: number;
}

/**
 * Pick the itinerary to ride for one segment. Providers already order their
 * results best-first, so the first option wins unless a deadline rules it out;
 * when nothing meets the deadline the earliest arrival is the least-bad answer
 * and the caller reports the shortfall as a violation.
 */
export function selectItinerary(
  itineraries: TripItinerary[],
  deadlineMs: number | null,
): TripItinerary | null {
  if (itineraries.length === 0) return null;
  if (deadlineMs === null) return itineraries[0];
  const inTime = itineraries.find((option) => Date.parse(option.endTime) <= deadlineMs);
  if (inTime) return inTime;
  return itineraries.reduce((earliest, option) =>
    Date.parse(option.endTime) < Date.parse(earliest.endTime) ? option : earliest,
  );
}

/** Realtime arrival minus scheduled arrival, from the last leg that reports both. */
function arrivalDelaySeconds(itinerary: TripItinerary): number {
  for (let index = itinerary.legs.length - 1; index >= 0; index -= 1) {
    const leg = itinerary.legs[index];
    if (leg.scheduledEndTime === undefined) continue;
    return Math.round((Date.parse(leg.endTime) - Date.parse(leg.scheduledEndTime)) / 1000);
  }
  return 0;
}

export async function planTransitChain(args: PlanTransitChainArgs): Promise<ChainedTripPlan> {
  const resolved = resolveScheduleConstraints({
    waypoints: args.waypoints.map((point, index) => ({
      coords: [point.lng, point.lat] as [number, number],
      schedule: args.schedules[index] ?? undefined,
    })),
    anchor: args.anchor,
  });

  const level = worstSupport(
    requiredTemporalSemantics(resolved).map((semantic) => args.capabilities[semantic]),
  );
  const warnings: ChainPlanWarning[] = [];
  const segments: (ChainedTripSegment | undefined)[] = new Array(
    Math.max(0, args.waypoints.length - 1),
  ).fill(undefined);
  let provider: string | undefined;

  const runSegment = async (
    segmentIndex: number,
    instantMs: number,
    pinArrival: boolean,
  ): Promise<{ seconds: number; payload: ChainedTripSegment }> => {
    const request: TripPlanRequest = {
      ...args.baseRequest,
      from: args.waypoints[segmentIndex],
      to: args.waypoints[segmentIndex + 1],
      ...(pinArrival
        ? { arrivalTime: new Date(instantMs).toISOString() }
        : { departureTime: new Date(instantMs).toISOString() }),
      ...(args.numItinerariesPerSegment ? { numItineraries: args.numItinerariesPerSegment } : {}),
    };

    const result = await args.planTrip(request);
    const itineraries = result.data?.itineraries ?? [];
    const deadline = pinArrival ? null : resolved.stops[segmentIndex + 1].latestArrivalMs;
    const chosen = selectItinerary(itineraries, deadline);
    if (!chosen) {
      warnings.push({ kind: "no-connection", segmentIndex });
      throw new Error(`no itinerary for segment ${segmentIndex}`);
    }
    provider ??= result.data?.provider;

    if (chosen.legs.some((leg) => leg.cancelled)) {
      warnings.push({ kind: "cancelled-leg", segmentIndex });
    }
    if (chosen.invalidRequirements && chosen.invalidRequirements.length > 0) {
      warnings.push({
        kind: "unmet-requirement",
        segmentIndex,
        requirements: chosen.invalidRequirements,
      });
    }

    const startMs = Date.parse(chosen.startTime);
    const endMs = Date.parse(chosen.endTime);
    // A transit leg's real cost from a given moment includes waiting for the
    // service, so the oracle reports the whole span. The wait is preserved
    // separately rather than folded away, so the timeline can still say
    // "leave at 09:00, the train goes at 09:17".
    const seconds = pinArrival
      ? Math.round((instantMs - startMs) / 1000)
      : Math.round((endMs - instantMs) / 1000);
    const boardingWaitSeconds = pinArrival
      ? 0
      : Math.max(0, Math.round((startMs - instantMs) / 1000));

    const segment: ChainedTripSegment = {
      fromIndex: segmentIndex,
      toIndex: segmentIndex + 1,
      itinerary: chosen,
      alternatives: itineraries.filter((option) => option !== chosen),
      boardingWaitSeconds,
      delaySeconds: arrivalDelaySeconds(chosen),
    };
    segments[segmentIndex] = segment;
    return { seconds, payload: segment };
  };

  const planned = await planScheduledTrip({
    resolved,
    forward: (segmentIndex, departureMs) => runSegment(segmentIndex, departureMs, false),
    backward: (segmentIndex, arrivalMs) => runSegment(segmentIndex, arrivalMs, true),
    providerId: provider,
  });

  const solved = segments.filter((segment): segment is ChainedTripSegment => segment !== undefined);

  // Guard the composed chain rather than trusting the provider: an itinerary
  // that starts before the previous segment lands is a real missed connection,
  // whatever departure time it was asked for.
  for (let index = 0; index + 1 < solved.length; index += 1) {
    const lands = Date.parse(solved[index].itinerary.endTime);
    const leaves = Date.parse(solved[index + 1].itinerary.startTime);
    if (leaves < lands) {
      warnings.push({
        kind: "missed-connection",
        afterSegmentIndex: index,
        overlapSeconds: Math.round((lands - leaves) / 1000),
      });
    }
  }

  return {
    segments: solved,
    schedule: planned.schedule,
    fidelity: fidelityFor(level),
    warnings,
    ...(provider ? { provider } : {}),
  };
}
