import type { LngLat } from "../types/geometry";
import type { ScheduleViolation, WaypointSchedule } from "../types/routing";
import { isoWithOffsetInZone, timeZoneAt, zonedWallClockToInstant } from "../utils/timezone";

/** A day. Longer stays are a different trip, not a dwell. */
export const MAX_DWELL_SECONDS = 86_400;

const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** One waypoint's constraints resolved to absolute instants. */
export interface ResolvedStopConstraint {
  index: number;
  timeZone: string;
  /** Epoch ms; the stop may not be left before this. */
  earliestDepartureMs: number | null;
  /** Epoch ms; the stop must be reached at or before this. */
  latestArrivalMs: number | null;
  dwellSeconds: number;
  /** Dwell was requested at an endpoint, where it has no meaning, and was dropped. */
  dwellIgnored: boolean;
}

export type ScheduleAnchor =
  | { kind: "now" }
  | { kind: "departAt"; wallClock: string }
  | { kind: "arriveBy"; wallClock: string };

export interface ResolveScheduleInput {
  waypoints: { coords: LngLat; schedule?: WaypointSchedule }[];
  anchor: ScheduleAnchor;
  /** Injected for tests; defaults to `Date.now()`. */
  nowMs?: number;
}

export interface ResolvedSchedule {
  /**
   * Each stop carries only the user's own constraints. The trip anchor is kept
   * out of them deliberately: folding it into stop 0 would make an ordinary
   * depart-at trip look like it carried a per-waypoint window, and the provider
   * chain would then demand the emulated waypoint semantics for nothing.
   */
  stops: ResolvedStopConstraint[];
  /** Always concrete: the `now` anchor resolves to `nowMs`. */
  anchorMs: number;
  anchor: ScheduleAnchor;
  direction: "forward" | "backward";
  violations: ScheduleViolation[];
}

function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zoneFor(coords: LngLat, explicit: string | undefined): string {
  if (explicit && isKnownZone(explicit)) return explicit;
  return timeZoneAt(coords[1], coords[0]) ?? "UTC";
}

function instantIn(zone: string, wallClock: string): number | null {
  if (!WALL_CLOCK.test(wallClock)) return null;
  return zonedWallClockToInstant(zone, wallClock)?.getTime() ?? null;
}

/**
 * Turn user-supplied wall clocks into absolute instants and report every
 * contradiction that can be found without asking a router how long anything
 * takes. The anchor resolves in the zone of the end it names — `departAt` at the
 * origin, `arriveBy` at the destination — matching what a traveller means and
 * what time-aware engines document.
 */
export function resolveScheduleConstraints(input: ResolveScheduleInput): ResolvedSchedule {
  const nowMs = input.nowMs ?? Date.now();
  const violations: ScheduleViolation[] = [];
  const lastIndex = input.waypoints.length - 1;

  const stops: ResolvedStopConstraint[] = input.waypoints.map(({ coords, schedule }, index) => {
    const timeZone = zoneFor(coords, schedule?.timeZone);
    const isEndpoint = index === 0 || index === lastIndex;

    const rawDwell = schedule?.dwellSeconds;
    let dwellSeconds = 0;
    if (rawDwell !== undefined) {
      if (!Number.isInteger(rawDwell) || rawDwell < 0 || rawDwell > MAX_DWELL_SECONDS) {
        violations.push({ kind: "invalid-dwell", waypointIndex: index, dwellSeconds: rawDwell });
      } else {
        dwellSeconds = rawDwell;
      }
    }
    const dwellIgnored = isEndpoint && dwellSeconds > 0;
    if (dwellIgnored) dwellSeconds = 0;

    const read = (field: "departAfter" | "arriveBy" | "fixedAt"): number | null => {
      const value = schedule?.[field];
      if (value === undefined) return null;
      const instant = instantIn(timeZone, value);
      if (instant === null) {
        violations.push({ kind: "invalid-time", waypointIndex: index, field, value });
      }
      return instant;
    };

    if (schedule?.fixedAt !== undefined) {
      const conflicting = (["departAfter", "arriveBy"] as const).filter(
        (field) => schedule[field] !== undefined,
      );
      if (conflicting.length > 0) {
        violations.push({
          kind: "conflicting-fields",
          waypointIndex: index,
          fields: ["fixedAt", ...conflicting],
        });
      }
    }

    const fixedAtMs = read("fixedAt");
    let latestArrivalMs = read("arriveBy");
    let earliestDepartureMs = read("departAfter");

    // An appointment is a deadline plus a departure measured from the
    // appointment itself, so arriving early still leaves at the same moment.
    if (fixedAtMs !== null) {
      latestArrivalMs = fixedAtMs;
      earliestDepartureMs = fixedAtMs + dwellSeconds * 1000;
      dwellSeconds = 0;
    }

    return { index, timeZone, earliestDepartureMs, latestArrivalMs, dwellSeconds, dwellIgnored };
  });

  const direction = input.anchor.kind === "arriveBy" ? "backward" : "forward";
  const anchorZone = direction === "backward" ? stops[lastIndex]?.timeZone : stops[0]?.timeZone;
  let anchorMs = nowMs;
  if (input.anchor.kind !== "now") {
    const parsed = anchorZone ? instantIn(anchorZone, input.anchor.wallClock) : null;
    if (parsed === null) {
      violations.push({
        kind: "invalid-time",
        waypointIndex: direction === "backward" ? Math.max(0, lastIndex) : 0,
        field: input.anchor.kind,
        value: input.anchor.wallClock,
      });
    } else {
      anchorMs = parsed;
    }
  }

  violations.push(
    ...scanOrder(
      stops,
      input.anchor.kind === "departAt" ? anchorMs : null,
      input.anchor.kind === "arriveBy" ? anchorMs : null,
    ),
  );

  return { stops, anchorMs, anchor: input.anchor, direction, violations };
}

/**
 * Travel time is never negative, so arrival at `j` is at least the earliest
 * departure from `i` plus every dwell in between. When that lower bound already
 * misses `j`'s deadline the trip is impossible before any route is requested.
 */
function scanOrder(
  stops: ResolvedStopConstraint[],
  pinnedDepartureMs: number | null,
  pinnedArrivalMs: number | null,
): ScheduleViolation[] {
  const violations: ScheduleViolation[] = [];
  const last = stops.length - 1;
  for (let from = 0; from < stops.length; from += 1) {
    const own = stops[from].earliestDepartureMs;
    // The origin cannot be left before a pinned departure either, so it takes
    // part in the scan even when the user set no window there.
    const pinned = from === 0 ? pinnedDepartureMs : null;
    const departure = own === null ? pinned : pinned === null ? own : Math.max(own, pinned);
    if (departure === null) continue;
    const boundByAnchor = from === 0 && pinned !== null && departure === pinned;
    let dwellBetween = 0;
    for (let to = from + 1; to < stops.length; to += 1) {
      const ownDeadline = stops[to].latestArrivalMs;
      const pinnedDeadline = to === last ? pinnedArrivalMs : null;
      const deadline =
        ownDeadline === null
          ? pinnedDeadline
          : pinnedDeadline === null
            ? ownDeadline
            : Math.min(ownDeadline, pinnedDeadline);
      if (deadline !== null && departure + dwellBetween > deadline) {
        violations.push(
          boundByAnchor
            ? {
                kind: "anchor-conflict",
                waypointIndex: stops[to].index,
                anchor: isoWithOffsetInZone(new Date(departure), stops[from].timeZone),
                latestArrival: isoWithOffsetInZone(new Date(deadline), stops[to].timeZone),
              }
            : {
                kind: "inverted-order",
                fromIndex: stops[from].index,
                toIndex: stops[to].index,
                earliestDeparture: isoWithOffsetInZone(new Date(departure), stops[from].timeZone),
                latestArrival: isoWithOffsetInZone(new Date(deadline), stops[to].timeZone),
              },
        );
      }
      dwellBetween += stops[to].dwellSeconds * 1000;
    }
  }
  return violations;
}
