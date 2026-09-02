import type { ScheduleFidelity, TemporalCapabilities, TemporalSupport } from "../types/routing";
import type { ResolvedSchedule } from "./scheduleConstraints";

export type TemporalSemantic = keyof TemporalCapabilities;

const RANK: Record<TemporalSupport, number> = {
  native: 3,
  emulated: 2,
  approximate: 1,
  unsupported: 0,
};

/**
 * Leg chaining works against any provider that can answer a two-point route,
 * so an undeclared time-aware provider can be trusted with the waypoint
 * semantics even though it knows nothing about them.
 */
export const TIME_AWARE_TEMPORAL_DEFAULT: TemporalCapabilities = {
  tripDepartAt: "native",
  tripArriveBy: "native",
  dwell: "emulated",
  waypointDepartAfter: "emulated",
  waypointArriveBy: "emulated",
  timeDependentTravel: "native",
};

/**
 * A provider whose durations ignore the departure instant still produces a
 * usable schedule — the arithmetic is exact, the travel times are estimates.
 */
export const TIME_AGNOSTIC_TEMPORAL_DEFAULT: TemporalCapabilities = {
  tripDepartAt: "approximate",
  tripArriveBy: "approximate",
  dwell: "approximate",
  waypointDepartAfter: "approximate",
  waypointArriveBy: "approximate",
  timeDependentTravel: "unsupported",
};

export function resolveTemporalCapabilities(provider: {
  temporal?: TemporalCapabilities;
  supportsTimeAware?: boolean;
}): TemporalCapabilities {
  if (provider.temporal) return provider.temporal;
  return provider.supportsTimeAware ? TIME_AWARE_TEMPORAL_DEFAULT : TIME_AGNOSTIC_TEMPORAL_DEFAULT;
}

/** Lowest level in the list. An empty list demands nothing, so it is `native`. */
export function worstSupport(levels: TemporalSupport[]): TemporalSupport {
  return levels.reduce<TemporalSupport>(
    (worst, level) => (RANK[level] < RANK[worst] ? level : worst),
    "native",
  );
}

export function fidelityFor(level: TemporalSupport): ScheduleFidelity {
  return level === "approximate" ? "approximate" : "exact";
}

/**
 * Which semantics a resolved request actually exercises. A trip-level pin asks
 * only for the trip-level semantic; the waypoint semantics are demanded solely
 * by constraints the user set on an individual stop.
 */
export function requiredTemporalSemantics(resolved: ResolvedSchedule): TemporalSemantic[] {
  const semantics = new Set<TemporalSemantic>();
  if (resolved.anchor.kind === "departAt") semantics.add("tripDepartAt");
  if (resolved.anchor.kind === "arriveBy") semantics.add("tripArriveBy");
  for (const stop of resolved.stops) {
    if (stop.dwellSeconds > 0) semantics.add("dwell");
    if (stop.earliestDepartureMs !== null) semantics.add("waypointDepartAfter");
    if (stop.latestArrivalMs !== null) semantics.add("waypointArriveBy");
  }
  return [...semantics];
}
