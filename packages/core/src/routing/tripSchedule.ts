import type {
  ScheduledLeg,
  ScheduledStop,
  ScheduleViolation,
  TripSchedule,
} from "../types/routing";
import { isoWithOffsetInZone, localDateInZone, tzOffsetMinutes } from "../utils/timezone";
import type { ResolvedStopConstraint } from "./scheduleConstraints";

export interface ComposeScheduleInput {
  stops: ResolvedStopConstraint[];
  /** Seconds for leg i, from stop i to stop i+1. Length is `stops.length - 1`. */
  legSeconds: number[];
  anchorMs: number;
  direction: "forward" | "backward";
}

/** Departure instant from a stop, given when you arrived there. */
export function departureAfter(stop: ResolvedStopConstraint, arrivalMs: number): number {
  const ready = arrivalMs + stop.dwellSeconds * 1000;
  return stop.earliestDepartureMs === null ? ready : Math.max(ready, stop.earliestDepartureMs);
}

/** Arrival instant at a stop, given when you must leave it. */
export function arrivalBefore(stop: ResolvedStopConstraint, departureMs: number): number {
  const latest = departureMs - stop.dwellSeconds * 1000;
  return stop.latestArrivalMs === null ? latest : Math.min(latest, stop.latestArrivalMs);
}

/**
 * Turn fixed leg durations plus resolved constraints into the canonical
 * timeline. Both directions are exact in a single pass, because leg `i`'s
 * departure is fully determined by the legs before it.
 */
export function composeSchedule(input: ComposeScheduleInput): TripSchedule {
  const { stops, legSeconds, anchorMs, direction } = input;
  const count = stops.length;
  const arrivalMs: (number | null)[] = new Array(count).fill(null);
  const departureMs: (number | null)[] = new Array(count).fill(null);
  const waitSeconds: number[] = new Array(count).fill(0);
  const violations: ScheduleViolation[] = [];

  const render = (ms: number, index: number) =>
    isoWithOffsetInZone(new Date(ms), stops[index].timeZone);

  if (direction === "forward") {
    departureMs[0] = departureAfter({ ...stops[0], dwellSeconds: 0 }, anchorMs);
    for (let leg = 0; leg < legSeconds.length; leg += 1) {
      const arrival = (departureMs[leg] as number) + legSeconds[leg] * 1000;
      const next = leg + 1;
      arrivalMs[next] = arrival;
      const deadline = stops[next].latestArrivalMs;
      if (deadline !== null && arrival > deadline) {
        violations.push({
          kind: "late-arrival",
          waypointIndex: stops[next].index,
          requiredBy: render(deadline, next),
          earliestArrival: render(arrival, next),
          shortfallSeconds: Math.round((arrival - deadline) / 1000),
        });
      }
      if (next < count - 1) {
        const departure = departureAfter(stops[next], arrival);
        departureMs[next] = departure;
        waitSeconds[next] = Math.round(
          (departure - arrival - stops[next].dwellSeconds * 1000) / 1000,
        );
      }
    }
  } else {
    const last = count - 1;
    arrivalMs[last] =
      stops[last].latestArrivalMs === null
        ? anchorMs
        : Math.min(anchorMs, stops[last].latestArrivalMs);
    for (let leg = legSeconds.length - 1; leg >= 0; leg -= 1) {
      const departure = (arrivalMs[leg + 1] as number) - legSeconds[leg] * 1000;
      departureMs[leg] = departure;
      const allowed = stops[leg].earliestDepartureMs;
      if (allowed !== null && departure < allowed) {
        violations.push({
          kind: "early-departure",
          waypointIndex: stops[leg].index,
          allowedFrom: render(allowed, leg),
          latestDeparture: render(departure, leg),
          shortfallSeconds: Math.round((allowed - departure) / 1000),
        });
      }
      if (leg > 0) {
        const arrival = arrivalBefore(stops[leg], departure);
        arrivalMs[leg] = arrival;
        waitSeconds[leg] = Math.round(
          (departure - arrival - stops[leg].dwellSeconds * 1000) / 1000,
        );
      }
    }
  }

  const scheduledStops: ScheduledStop[] = stops.map((stop, index) => {
    const reference = arrivalMs[index] ?? departureMs[index] ?? anchorMs;
    return {
      waypointIndex: stop.index,
      timeZone: stop.timeZone,
      ...(arrivalMs[index] !== null ? { arrival: render(arrivalMs[index] as number, index) } : {}),
      ...(departureMs[index] !== null
        ? { departure: render(departureMs[index] as number, index) }
        : {}),
      dwellSeconds: stop.dwellSeconds,
      waitSeconds: waitSeconds[index],
      utcOffsetMinutes: tzOffsetMinutes(new Date(reference), stop.timeZone) ?? 0,
    };
  });

  const legs: ScheduledLeg[] = legSeconds.map((seconds, leg) => ({
    fromIndex: stops[leg].index,
    toIndex: stops[leg + 1].index,
    departure: render(departureMs[leg] as number, leg),
    arrival: render(arrivalMs[leg + 1] as number, leg + 1),
    travelSeconds: seconds,
  }));

  // A walk that broke on its first leg leaves one stop and no leg, so neither
  // end is guaranteed to be set. Falling back through the other end and then the
  // anchor keeps the degenerate schedule renderable instead of showing 1970.
  const tripDepartureMs = departureMs[0] ?? arrivalMs[0] ?? anchorMs;
  const tripArrivalMs = arrivalMs[count - 1] ?? departureMs[count - 1] ?? tripDepartureMs;

  return {
    stops: scheduledStops,
    legs,
    departure: render(tripDepartureMs, 0),
    arrival: render(tripArrivalMs, count - 1),
    totalTravelSeconds: legSeconds.reduce((sum, seconds) => sum + seconds, 0),
    totalDwellSeconds: stops.reduce((sum, stop) => sum + stop.dwellSeconds, 0),
    totalWaitSeconds: waitSeconds.reduce((sum, seconds) => sum + seconds, 0),
    // Compared in each end's own zone, which is what a traveller means by
    // "this trip runs into tomorrow".
    multiDay:
      localDateInZone(new Date(tripDepartureMs), stops[0].timeZone) !==
      localDateInZone(new Date(tripArrivalMs), stops[count - 1].timeZone),
    violations,
  };
}
