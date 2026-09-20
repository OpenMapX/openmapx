import {
  type ChainedTripSegment,
  departureAfter,
  isoWithOffsetInZone,
  localDateInZone,
  type ResolvedSchedule,
  type ScheduleViolation,
  type TripSchedule,
  tzOffsetMinutes,
} from "@openmapx/core";

/** Compose observed service times; an arrive-by bound is never an observed arrival. */
export function composeBackwardTransitSchedule(args: {
  resolved: ResolvedSchedule;
  /** Ascending original indices, forming a contiguous suffix of the trip. */
  segments: ChainedTripSegment[];
  violations: ScheduleViolation[];
}): TripSchedule {
  const { resolved, segments } = args;
  const finalStop = resolved.stops.at(-1);
  if (resolved.stops.length < 2 || !finalStop) {
    throw new Error("Backward transit schedules require at least two stops");
  }
  const violations = [...args.violations];
  const arrivals = new Map<number, number>();
  const departures = new Map<number, number>();
  for (const segment of segments) {
    departures.set(segment.fromIndex, Date.parse(segment.itinerary.startTime));
    arrivals.set(segment.toIndex, Date.parse(segment.itinerary.endTime));
  }
  const firstIndex = segments[0]?.fromIndex ?? finalStop.index;
  const retained = resolved.stops.filter((stop) => stop.index >= firstIndex);
  const render = (instant: number, index: number) =>
    isoWithOffsetInZone(new Date(instant), resolved.stops[index].timeZone);

  const stops = retained.map((stop) => {
    const arrival = arrivals.get(stop.index);
    const departure = departures.get(stop.index);
    const dwellSeconds = arrival !== undefined && departure !== undefined ? stop.dwellSeconds : 0;
    const waitSeconds =
      arrival !== undefined && departure !== undefined
        ? Math.max(0, Math.round((departure - arrival) / 1000) - dwellSeconds)
        : 0;
    const deadline =
      stop.index === finalStop.index
        ? Math.min(resolved.anchorMs, stop.latestArrivalMs ?? resolved.anchorMs)
        : stop.latestArrivalMs;
    if (arrival !== undefined && deadline !== null && arrival > deadline) {
      violations.push({
        kind: "late-arrival",
        waypointIndex: stop.index,
        requiredBy: render(deadline, stop.index),
        earliestArrival: render(arrival, stop.index),
        shortfallSeconds: Math.round((arrival - deadline) / 1000),
      });
    }
    const allowed =
      arrival !== undefined ? departureAfter(stop, arrival) : stop.earliestDepartureMs;
    if (departure !== undefined && allowed !== null && departure < allowed) {
      violations.push({
        kind: "early-departure",
        waypointIndex: stop.index,
        allowedFrom: render(allowed, stop.index),
        latestDeparture: render(departure, stop.index),
        shortfallSeconds: Math.round((allowed - departure) / 1000),
      });
    }
    return {
      waypointIndex: stop.index,
      timeZone: stop.timeZone,
      ...(arrival !== undefined ? { arrival: render(arrival, stop.index) } : {}),
      ...(departure !== undefined ? { departure: render(departure, stop.index) } : {}),
      dwellSeconds,
      waitSeconds,
      utcOffsetMinutes:
        tzOffsetMinutes(new Date(arrival ?? departure ?? resolved.anchorMs), stop.timeZone) ?? 0,
    };
  });
  const legs = segments.map((segment) => ({
    fromIndex: segment.fromIndex,
    toIndex: segment.toIndex,
    departure: render(Date.parse(segment.itinerary.startTime), segment.fromIndex),
    arrival: render(Date.parse(segment.itinerary.endTime), segment.toIndex),
    travelSeconds: Math.round(
      (Date.parse(segment.itinerary.endTime) - Date.parse(segment.itinerary.startTime)) / 1000,
    ),
  }));
  const startMs = departures.get(firstIndex) ?? resolved.anchorMs;
  const endMs = arrivals.get(finalStop.index) ?? resolved.anchorMs;
  return {
    stops,
    legs,
    departure: render(startMs, firstIndex),
    arrival: render(endMs, finalStop.index),
    totalTravelSeconds: legs.reduce((sum, leg) => sum + leg.travelSeconds, 0),
    totalDwellSeconds: stops.reduce((sum, stop) => sum + stop.dwellSeconds, 0),
    totalWaitSeconds: stops.reduce((sum, stop) => sum + stop.waitSeconds, 0),
    multiDay:
      localDateInZone(new Date(startMs), resolved.stops[firstIndex].timeZone) !==
      localDateInZone(new Date(endMs), finalStop.timeZone),
    violations,
  };
}
