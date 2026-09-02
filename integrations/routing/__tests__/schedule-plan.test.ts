import type { DirectionsResult, RoutingOptions, TravelMode } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedProvider } from "../orchestrator.js";
import { NoScheduleProviderError, runSchedulePlan } from "../schedule-plan.js";
import { parseScheduleRequest } from "../schedule-request.js";
import type { Route } from "../types.js";

const COLOGNE: [number, number] = [6.96, 50.94];
const BONN: [number, number] = [7.1, 50.73];
const AACHEN: [number, number] = [6.08, 50.77];

function routeOf(seconds: number, from: [number, number], to: [number, number]): Route {
  return {
    distance: seconds * 20,
    duration: seconds,
    geometry: [from, to],
    legs: [{ distance: seconds * 20, duration: seconds, geometry: [from, to], steps: [] }],
    steps: [],
    mode: "driving",
  };
}

type GetRoute = (
  waypoints: [number, number][],
  mode: TravelMode,
  options?: RoutingOptions,
) => Promise<DirectionsResult>;

function provider(
  overrides: { id: string } & Partial<ResolvedProvider["provider"]>,
  getRoute: GetRoute,
): ResolvedProvider {
  return {
    integrationId: overrides.id,
    provider: {
      supportedModes: ["driving"],
      getRoute,
      ...overrides,
    } as unknown as ResolvedProvider["provider"],
  };
}

const NATIVE_DWELL = {
  tripDepartAt: "native",
  tripArriveBy: "native",
  dwell: "native",
  waypointDepartAfter: "emulated",
  waypointArriveBy: "emulated",
  timeDependentTravel: "native",
} as const;

const APPROXIMATE = {
  tripDepartAt: "approximate",
  tripArriveBy: "approximate",
  dwell: "approximate",
  waypointDepartAfter: "approximate",
  waypointArriveBy: "approximate",
  timeDependentTravel: "unsupported",
} as const;

describe("runSchedulePlan", () => {
  it("takes the single-call path for a dwell-only trip on a native-dwell provider", async () => {
    const getRoute = vi.fn<GetRoute>(async (waypoints) => ({
      waypoints,
      routes: [
        {
          ...routeOf(7200, COLOGNE, AACHEN),
          legs: [
            { distance: 1, duration: 3600, geometry: [COLOGNE, BONN], steps: [] },
            { distance: 1, duration: 3600, geometry: [BONN, AACHEN], steps: [] },
          ],
        },
      ],
      activeRouteIndex: 0,
    }));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { dwellSeconds: 1800 }, null],
        departAt: "2026-09-01T09:00",
      }),
      [provider({ id: "valhalla", temporal: NATIVE_DWELL }, getRoute)],
    );

    expect(getRoute).toHaveBeenCalledTimes(1);
    expect(getRoute.mock.calls[0][2]?.dwellSeconds).toEqual([0, 1800, 0]);
    expect(result.schedule.stops[1].departure).toBe("2026-09-01T10:30:00+02:00");
    expect(result.schedule.arrival).toBe("2026-09-01T11:30:00+02:00");
    expect(result.fidelity).toBe("exact");
    expect(result.warnings).toEqual([]);
  });

  it("chains one call per leg when a window is present, pinning each departure", async () => {
    const calls: { waypoints: [number, number][]; departAt?: string }[] = [];
    const getRoute = vi.fn<GetRoute>(async (waypoints, _mode, options) => {
      calls.push({ waypoints, departAt: options?.departAt });
      return {
        waypoints,
        routes: [routeOf(3600, waypoints[0], waypoints[1])],
        activeRouteIndex: 0,
      };
    });
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { departAfter: "2026-09-01T12:00" }, null],
        departAt: "2026-09-01T09:00",
      }),
      [provider({ id: "valhalla", supportsTimeAware: true }, getRoute)],
    );

    expect(getRoute).toHaveBeenCalledTimes(2);
    expect(calls[0]).toMatchObject({ departAt: "2026-09-01T09:00" });
    expect(calls[0].waypoints).toEqual([COLOGNE, BONN]);
    expect(calls[1]).toMatchObject({ departAt: "2026-09-01T12:00" });
    expect(calls[1].waypoints).toEqual([BONN, AACHEN]);
    expect(result.schedule.stops[1].waitSeconds).toBe(2 * 3600);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].legs).toHaveLength(2);
    expect(result.routes[0].duration).toBe(7200);
  });

  it("pins arrivals instead of departures on a backward solve", async () => {
    const arrivals: (string | undefined)[] = [];
    const getRoute = vi.fn<GetRoute>(async (waypoints, _mode, options) => {
      arrivals.push(options?.arriveBy);
      return {
        waypoints,
        routes: [routeOf(3600, waypoints[0], waypoints[1])],
        activeRouteIndex: 0,
      };
    });
    await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { dwellSeconds: 1800 }, null],
        arriveBy: "2026-09-01T18:00",
      }),
      [provider({ id: "valhalla", supportsTimeAware: true }, getRoute)],
    );
    expect(arrivals).toEqual(["2026-09-01T18:00", "2026-09-01T16:30"]);
  });

  it("labels an OSRM-served schedule approximate and warns", async () => {
    const getRoute = vi.fn<GetRoute>(async (waypoints) => ({
      waypoints,
      routes: [routeOf(3600, waypoints[0], waypoints[1])],
      activeRouteIndex: 0,
    }));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { dwellSeconds: 600 }, null],
      }),
      [provider({ id: "osrm", temporal: APPROXIMATE }, getRoute)],
    );
    expect(result.fidelity).toBe("approximate");
    expect(result.warnings).toContainEqual({
      kind: "approximate-travel-times",
      providerId: "osrm",
    });
  });

  it("falls through to the next provider for a failing leg and warns", async () => {
    const failing = vi.fn<GetRoute>(async (waypoints) => {
      // Compare by value: parseScheduleRequest rebuilds the coordinate arrays.
      if (waypoints[0][0] === BONN[0]) throw new Error("engine down");
      return {
        waypoints,
        routes: [routeOf(3600, waypoints[0], waypoints[1])],
        activeRouteIndex: 0,
      };
    });
    const backup = vi.fn<GetRoute>(async (waypoints) => ({
      waypoints,
      routes: [routeOf(5400, waypoints[0], waypoints[1])],
      activeRouteIndex: 0,
    }));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { departAfter: "2026-09-01T12:00" }, null],
      }),
      [
        provider({ id: "valhalla", supportsTimeAware: true }, failing),
        provider({ id: "osrm", supportsTimeAware: true }, backup),
      ],
    );
    expect(backup).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContainEqual({
      kind: "provider-fallback",
      from: "valhalla",
      to: "osrm",
    });
    expect(result.schedule.violations).toEqual([]);
  });

  it("reports an unreachable leg when every provider fails", async () => {
    const dead = vi.fn<GetRoute>(async () => {
      throw new Error("engine down");
    });
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { departAfter: "2026-09-01T12:00" }, null],
      }),
      [provider({ id: "valhalla", supportsTimeAware: true }, dead)],
    );
    expect(result.schedule.violations).toContainEqual({
      kind: "unreachable",
      fromIndex: 0,
      toIndex: 1,
    });
    expect(result.routes).toEqual([]);
  });

  it("warns when dwell was requested at an endpoint", async () => {
    const getRoute = vi.fn<GetRoute>(async (waypoints) => ({
      waypoints,
      routes: [routeOf(3600, waypoints[0], waypoints[1])],
      activeRouteIndex: 0,
    }));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN],
        schedules: [{ dwellSeconds: 900 }, null],
      }),
      [provider({ id: "valhalla", supportsTimeAware: true }, getRoute)],
    );
    expect(result.warnings).toContainEqual({
      kind: "dwell-ignored-at-endpoint",
      waypointIndex: 0,
    });
  });

  it("rejects a backward solve when no provider supports it", async () => {
    const getRoute = vi.fn<GetRoute>();
    await expect(
      runSchedulePlan(
        parseScheduleRequest({ waypoints: [COLOGNE, BONN], arriveBy: "2026-09-01T18:00" }),
        [
          provider(
            {
              id: "toy",
              temporal: { ...NATIVE_DWELL, tripArriveBy: "unsupported" },
            },
            getRoute,
          ),
        ],
      ),
    ).rejects.toBeInstanceOf(NoScheduleProviderError);
    expect(getRoute).not.toHaveBeenCalled();
  });

  it("falls back to leg chaining when the engine returns the wrong number of legs", async () => {
    const getRoute = vi.fn<GetRoute>(async (waypoints) => ({
      waypoints,
      // A single leg for a three-waypoint request: the engine collapsed the trip.
      routes: [routeOf(3600, waypoints[0], waypoints[waypoints.length - 1])],
      activeRouteIndex: 0,
    }));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { dwellSeconds: 600 }, null],
      }),
      [provider({ id: "valhalla", temporal: NATIVE_DWELL }, getRoute)],
    );
    // One rejected single call, then one call per leg.
    expect(getRoute).toHaveBeenCalledTimes(3);
    expect(result.routes[0].legs).toHaveLength(2);
  });
});
