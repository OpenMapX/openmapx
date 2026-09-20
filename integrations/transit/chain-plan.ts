import type { ChainedTripPlan, ChainedTripSegment, ChainPlanWarning } from "@openmapx/core";
import {
  arrivalBefore,
  departureAfter,
  fidelityFor,
  planScheduledTrip,
  requiredTemporalSemantics,
  resolveScheduleConstraints,
  type ScheduleAnchor,
  type TemporalCapabilities,
  type TripSchedule,
  type WaypointSchedule,
  worstSupport,
} from "@openmapx/core";
import type { TripPlanRequest } from "@openmapx/integration-framework";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { TripItinerary, TripPlan } from "@openmapx/mobility-core/transit";
import { composeBackwardTransitSchedule } from "./backward-chain-schedule.js";

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

  const finalStop = resolved.stops.at(-1);
  if (resolved.stops.length < 2 || !finalStop) {
    throw new Error("Transit chains require at least two stops");
  }

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
  ): Promise<ChainedTripSegment> => {
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
    const options = result.data?.itineraries ?? [];
    const itineraries = pinArrival
      ? options.filter((option) => {
          const start = Date.parse(option.startTime);
          const end = Date.parse(option.endTime);
          return Number.isFinite(start) && Number.isFinite(end) && end >= start;
        })
      : options;
    const deadline = pinArrival ? instantMs : resolved.stops[segmentIndex + 1].latestArrivalMs;
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
    return segment;
  };

  let schedule: TripSchedule;
  if (resolved.direction === "backward") {
    let deadline = Math.min(resolved.anchorMs, finalStop.latestArrivalMs ?? resolved.anchorMs);
    const violations = [...resolved.violations];
    for (let index = resolved.stops.length - 2; index >= 0; index -= 1) {
      let segment: ChainedTripSegment;
      try {
        segment = await runSegment(index, deadline, true);
      } catch {
        violations.push({ kind: "unreachable", fromIndex: index, toIndex: index + 1 });
        break;
      }
      deadline = arrivalBefore(resolved.stops[index], Date.parse(segment.itinerary.startTime));
    }
    const retained = segments.filter(
      (segment): segment is ChainedTripSegment => segment !== undefined,
    );
    for (let index = 1; index < retained.length; index += 1) {
      const segment = retained[index];
      const ready = departureAfter(
        resolved.stops[segment.fromIndex],
        Date.parse(retained[index - 1].itinerary.endTime),
      );
      segment.boardingWaitSeconds = Math.max(
        0,
        Math.round((Date.parse(segment.itinerary.startTime) - ready) / 1000),
      );
    }
    schedule = composeBackwardTransitSchedule({ resolved, segments: retained, violations });
  } else {
    const planned = await planScheduledTrip({
      resolved,
      forward: async (segmentIndex, departureMs) => {
        const segment = await runSegment(segmentIndex, departureMs, false);
        // Forward cost still includes waiting from the requested departure.
        return {
          seconds: Math.round((Date.parse(segment.itinerary.endTime) - departureMs) / 1000),
          payload: segment,
        };
      },
      providerId: provider,
    });
    schedule = planned.schedule;
  }

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
        afterSegmentIndex: solved[index].fromIndex,
        overlapSeconds: Math.round((lands - leaves) / 1000),
      });
    }
  }

  return {
    segments: solved,
    schedule,
    fidelity: fidelityFor(level),
    warnings,
    ...(provider ? { provider } : {}),
  };
}
