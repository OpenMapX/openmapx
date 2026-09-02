import {
  composeSchedule,
  fidelityFor,
  isoWithOffsetInZone,
  planScheduledTrip,
  type ResolvedSchedule,
  requiredTemporalSemantics,
  resolveScheduleConstraints,
  resolveTemporalCapabilities,
  type ScheduledDirectionsResult,
  type SchedulePlanWarning,
  type TemporalSemantic,
  type TemporalSupport,
  type TripSchedule,
  worstSupport,
} from "@openmapx/core";
import type { ResolvedProvider } from "./orchestrator.js";
import { concatenateRoutes } from "./route-concat.js";
import type { ParsedScheduleRequest } from "./schedule-request.js";
import type { Route, RoutingOptions } from "./types.js";

/** No provider can honour every semantic this request needs. */
export class NoScheduleProviderError extends Error {
  readonly status = 503;

  constructor(
    readonly missing: TemporalSemantic[],
    readonly mode: string,
  ) {
    super(`No routing provider supports ${missing.join(", ")} for mode: ${mode}`);
    this.name = "NoScheduleProviderError";
  }
}

interface EligibleProvider {
  resolved: ResolvedProvider;
  level: TemporalSupport;
}

/**
 * The chain filtered to providers that can honour every semantic this request
 * uses. `unsupported` on any needed semantic removes the provider entirely.
 */
function eligibleProviders(
  chain: ResolvedProvider[],
  semantics: TemporalSemantic[],
): EligibleProvider[] {
  return chain
    .map((resolved) => {
      const capabilities = resolveTemporalCapabilities(resolved.provider);
      return { resolved, level: worstSupport(semantics.map((s) => capabilities[s])) };
    })
    .filter((entry) => entry.level !== "unsupported");
}

/** The engine wall clock for a leg endpoint, in that endpoint's own zone. */
function wallClockIn(instantMs: number, timeZone: string): string {
  return isoWithOffsetInZone(new Date(instantMs), timeZone).slice(0, 16);
}

export interface SchedulePlanHooks {
  onProviderCall?: (providerId: string, outcome: "ok" | "error", durationMs: number) => void;
}

type ChainCall = (
  waypoints: [number, number][],
  options: RoutingOptions,
) => Promise<{ route: Route; providerId: string }>;

export async function runSchedulePlan(
  request: ParsedScheduleRequest,
  chain: ResolvedProvider[],
  hooks: SchedulePlanHooks = {},
): Promise<ScheduledDirectionsResult> {
  const resolved = resolveScheduleConstraints({
    waypoints: request.waypoints.map((coords, index) => ({
      coords,
      schedule: request.schedules[index] ?? undefined,
    })),
    anchor: request.anchor,
  });

  const semantics = requiredTemporalSemantics(resolved);
  const eligible = eligibleProviders(chain, semantics);
  if (eligible.length === 0) throw new NoScheduleProviderError(semantics, request.travelMode);

  const warnings: SchedulePlanWarning[] = resolved.stops
    .filter((stop) => stop.dwellIgnored)
    .map((stop) => ({ kind: "dwell-ignored-at-endpoint", waypointIndex: stop.index }));

  const level = worstSupport(eligible.map((entry) => entry.level));
  const fidelity = fidelityFor(level);
  if (fidelity === "approximate") {
    warnings.push({
      kind: "approximate-travel-times",
      providerId: eligible[0].resolved.integrationId,
    });
  }

  const seenFallbacks = new Set<string>();
  const noteFallback = (from: string, to: string) => {
    const key = `${from}->${to}`;
    if (seenFallbacks.has(key)) return;
    seenFallbacks.add(key);
    warnings.push({ kind: "provider-fallback", from, to });
  };

  const callChain: ChainCall = async (waypoints, options) => {
    let lastError: unknown;
    let previousId: string | undefined;
    for (const { resolved: candidate } of eligible) {
      const startedAt = performance.now();
      try {
        const result = await candidate.provider.getRoute(waypoints, request.travelMode, options);
        const route = result.routes[result.activeRouteIndex] ?? result.routes[0];
        if (!route) throw new Error("provider returned no route");
        hooks.onProviderCall?.(candidate.integrationId, "ok", performance.now() - startedAt);
        if (previousId) noteFallback(previousId, candidate.integrationId);
        return { route, providerId: candidate.integrationId };
      } catch (error) {
        hooks.onProviderCall?.(candidate.integrationId, "error", performance.now() - startedAt);
        previousId = candidate.integrationId;
        lastError = error;
      }
    }
    throw lastError ?? new Error("All routing providers failed");
  };

  const finish = (
    routes: Route[],
    providerId: string,
    schedule: TripSchedule,
  ): ScheduledDirectionsResult => ({
    waypoints: request.waypoints,
    routes,
    activeRouteIndex: 0,
    provider: providerId,
    schedule,
    fidelity,
    temporal: resolveTemporalCapabilities(eligible[0].resolved.provider),
    warnings,
  });

  const single = await trySingleCall(request, resolved, eligible, callChain);
  if (single) {
    const schedule = composeSchedule({
      stops: resolved.stops,
      legSeconds: single.legSeconds,
      anchorMs: resolved.anchorMs,
      direction: resolved.direction,
    });
    schedule.violations = [...resolved.violations, ...schedule.violations];
    return finish([single.route], single.providerId, schedule);
  }

  let servedBy = eligible[0].resolved.integrationId;
  const oracle = async (legIndex: number, instantMs: number, pinArrival: boolean) => {
    const pair: [number, number][] = [request.waypoints[legIndex], request.waypoints[legIndex + 1]];
    const zone = resolved.stops[pinArrival ? legIndex + 1 : legIndex].timeZone;
    const call = await callChain(pair, {
      ...request.routingOptions,
      ...(pinArrival
        ? { arriveBy: wallClockIn(instantMs, zone) }
        : { departAt: wallClockIn(instantMs, zone) }),
    });
    servedBy = call.providerId;
    return { seconds: call.route.duration, payload: call.route };
  };

  const planned = await planScheduledTrip({
    resolved,
    forward: (legIndex, departureMs) => oracle(legIndex, departureMs, false),
    backward: (legIndex, arrivalMs) => oracle(legIndex, arrivalMs, true),
    providerId: eligible[0].resolved.integrationId,
  });

  const legRoutes = planned.legPayloads.filter(
    (payload): payload is Route => payload !== undefined,
  );
  // Every leg failed. There is no geometry to draw, but the schedule still
  // carries the `unreachable` violation that explains why, and the caller needs
  // that far more than it needs an exception.
  const routes = legRoutes.length > 0 ? [concatenateRoutes(legRoutes)] : [];
  return finish(routes, servedBy, planned.schedule);
}

/**
 * A dwell-only trip on an engine that models service time natively is one round
 * trip, and the engine's own clock advances across each stop, so later legs are
 * costed for the later hour. Returns `null` when the request or the chain does
 * not qualify, or when the engine did not return one leg per requested segment —
 * in which case the caller falls through to leg chaining rather than guessing.
 */
async function trySingleCall(
  request: ParsedScheduleRequest,
  resolved: ResolvedSchedule,
  eligible: EligibleProvider[],
  callChain: ChainCall,
): Promise<{ route: Route; providerId: string; legSeconds: number[] } | null> {
  if (request.hasWindows) return null;
  const nativeDwell = eligible.some(
    (entry) => resolveTemporalCapabilities(entry.resolved.provider).dwell === "native",
  );
  if (!nativeDwell) return null;

  const anchor = request.anchor;
  const call = await callChain(request.waypoints, {
    ...request.routingOptions,
    dwellSeconds: resolved.stops.map((stop) => stop.dwellSeconds),
    ...(anchor.kind === "departAt" ? { departAt: anchor.wallClock } : {}),
    ...(anchor.kind === "arriveBy" ? { arriveBy: anchor.wallClock } : {}),
  });

  const legSeconds = call.route.legs.map((leg) => leg.duration);
  if (legSeconds.length !== request.waypoints.length - 1) return null;

  // Dwell belongs to the schedule, never to travel time. Pinning the route's
  // duration to the sum of its legs keeps that true even if an engine folds
  // service time into its trip summary.
  const travelSeconds = legSeconds.reduce((sum, seconds) => sum + seconds, 0);
  const route: Route = { ...call.route, duration: travelSeconds };

  return { route, providerId: call.providerId, legSeconds };
}
