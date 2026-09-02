import type { ScheduleViolation, TripSchedule } from "../types/routing";
import type { ResolvedSchedule } from "./scheduleConstraints";
import { arrivalBefore, composeSchedule, departureAfter } from "./tripSchedule";

export interface LegTravelResult {
  seconds: number;
  /** Opaque per-leg value the caller composes into its own result. */
  payload?: unknown;
}

/** How long leg `legIndex` takes when it is left at `departureMs`. */
export type ForwardLegOracle = (legIndex: number, departureMs: number) => Promise<LegTravelResult>;
/** How long leg `legIndex` takes when it must land at `arrivalMs`. */
export type BackwardLegOracle = (legIndex: number, arrivalMs: number) => Promise<LegTravelResult>;

export interface ScheduledTripResult {
  schedule: TripSchedule;
  /** Leg payloads in leg order, however the walk ran. */
  legPayloads: unknown[];
}

/**
 * Raised when the chosen provider cannot answer legs in the direction the trip
 * anchor demands. Carrying the provider id keeps the operator-facing message
 * specific instead of a bare "unavailable".
 */
export class UnsupportedScheduleDirectionError extends Error {
  readonly code = "backward-solve-unsupported";

  constructor(
    readonly direction: "forward" | "backward",
    readonly providerId?: string,
  ) {
    super(`No ${direction}-capable leg oracle${providerId ? ` for provider ${providerId}` : ""}`);
    this.name = "UnsupportedScheduleDirectionError";
  }
}

/**
 * Walk the legs in solve order, asking the oracle once per leg, and hand the
 * durations to {@link composeSchedule}. One pass is exact in either direction
 * because each leg's pinned instant is fully determined by the legs already
 * resolved — there is no fixed point to iterate towards.
 */
export async function planScheduledTrip(args: {
  resolved: ResolvedSchedule;
  forward?: ForwardLegOracle;
  backward?: BackwardLegOracle;
  providerId?: string;
}): Promise<ScheduledTripResult> {
  const { resolved, forward, backward, providerId } = args;
  const { stops, anchorMs, direction } = resolved;
  const legCount = Math.max(0, stops.length - 1);
  const legSeconds: (number | undefined)[] = new Array(legCount).fill(undefined);
  const legPayloads: unknown[] = new Array(legCount).fill(undefined);
  const violations: ScheduleViolation[] = [...resolved.violations];

  if (direction === "forward") {
    if (!forward) throw new UnsupportedScheduleDirectionError("forward", providerId);
    let departure = departureAfter({ ...stops[0], dwellSeconds: 0 }, anchorMs);
    for (let leg = 0; leg < legCount; leg += 1) {
      let travel: LegTravelResult;
      try {
        travel = await forward(leg, departure);
      } catch {
        violations.push({
          kind: "unreachable",
          fromIndex: stops[leg].index,
          toIndex: stops[leg + 1].index,
        });
        break;
      }
      legSeconds[leg] = travel.seconds;
      legPayloads[leg] = travel.payload;
      departure = departureAfter(stops[leg + 1], departure + travel.seconds * 1000);
    }
  } else {
    if (!backward) throw new UnsupportedScheduleDirectionError("backward", providerId);
    const last = stops.length - 1;
    let arrival =
      stops[last].latestArrivalMs === null
        ? anchorMs
        : Math.min(anchorMs, stops[last].latestArrivalMs);
    for (let leg = legCount - 1; leg >= 0; leg -= 1) {
      let travel: LegTravelResult;
      try {
        travel = await backward(leg, arrival);
      } catch {
        violations.push({
          kind: "unreachable",
          fromIndex: stops[leg].index,
          toIndex: stops[leg + 1].index,
        });
        break;
      }
      legSeconds[leg] = travel.seconds;
      legPayloads[leg] = travel.payload;
      arrival = arrivalBefore(stops[leg], arrival - travel.seconds * 1000);
    }
  }

  // A failed leg truncates the trip rather than erasing it: a schedule that is
  // right up to the break is more useful than none at all. Forward walks keep a
  // prefix, backward walks keep a suffix, and either way the retained stops stay
  // contiguous with the anchor.
  const solved = legSeconds.filter((seconds): seconds is number => seconds !== undefined);
  const complete = solved.length === legCount;
  const firstSolved = legSeconds.findIndex((seconds) => seconds !== undefined);
  const start = complete || direction === "forward" || firstSolved < 0 ? 0 : firstSolved;
  const retainedStops = stops.slice(start, start + solved.length + 1);

  const schedule = composeSchedule({
    stops: retainedStops,
    legSeconds: solved,
    anchorMs,
    direction,
  });
  schedule.violations = [...violations, ...schedule.violations];

  return { schedule, legPayloads: legPayloads.slice(start, start + solved.length) };
}
