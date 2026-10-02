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

function resultOf(waypoints: [number, number][]): DirectionsResult {
  const legs = waypoints
    .slice(1)
    .map((point, index) => routeOf(3600, waypoints[index], point).legs[0]);
  return {
    waypoints,
    activeRouteIndex: 0,
    routes: [
      {
        ...routeOf(3600 * legs.length, waypoints[0], waypoints[waypoints.length - 1]),
        geometry: waypoints,
        legs,
      },
    ],
  };
}

const windowedRequest = () =>
  parseScheduleRequest({
    waypoints: [COLOGNE, BONN, AACHEN],
    schedules: [null, { departAfter: "2026-09-01T12:00" }, null],
    departAt: "2026-09-01T09:00",
  });

describe("retained schedule provider metadata", () => {
  it("aggregates each retained semantic independently without downgrading exact emulation", async () => {
    const secondaryTemporal = {
      ...NATIVE_DWELL,
      tripArriveBy: "unsupported",
      dwell: "emulated",
      timeDependentTravel: "emulated",
    } as const;
    const primary = vi.fn<GetRoute>(async (waypoints) => {
      if (waypoints[0][0] === BONN[0]) throw new Error("leg unavailable");
      return resultOf(waypoints);
    });
    const backup = vi.fn<GetRoute>(async (waypoints) => resultOf(waypoints));
    const result = await runSchedulePlan(windowedRequest(), [
      provider({ id: "native", temporal: NATIVE_DWELL }, primary),
      provider({ id: "emulated", temporal: secondaryTemporal }, backup),
    ]);
    expect(result.temporal).toEqual(secondaryTemporal);
    expect(result.fidelity).toBe("exact");
    expect(
      result.warnings.filter((warning) => warning.kind === "approximate-travel-times"),
    ).toEqual([]);
  });

  it("warns once for each actual approximate contributor across repeated legs", async () => {
    const first = vi.fn<GetRoute>(async (waypoints) => {
      if (waypoints[0][0] !== COLOGNE[0]) throw new Error("leg unavailable");
      return resultOf(waypoints);
    });
    const second = vi.fn<GetRoute>(async (waypoints) => resultOf(waypoints));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN, COLOGNE],
        schedules: [null, { departAfter: "2026-09-01T12:00" }, null, null],
        departAt: "2026-09-01T09:00",
      }),
      [
        provider({ id: "osrm-a", temporal: APPROXIMATE }, first),
        provider({ id: "osrm-b", temporal: APPROXIMATE }, second),
      ],
    );
    expect(result.routes[0].legs).toHaveLength(3);
    expect(
      result.warnings.filter((warning) => warning.kind === "approximate-travel-times"),
    ).toEqual([
      { kind: "approximate-travel-times", providerId: "osrm-a" },
      { kind: "approximate-travel-times", providerId: "osrm-b" },
    ]);
    expect(result.warnings.filter((warning) => warning.kind === "provider-fallback")).toEqual([
      { kind: "provider-fallback", from: "osrm-a", to: "osrm-b" },
    ]);
  });

  it("preserves the last-served provider label for a backward mixed chain", async () => {
    const primary = vi.fn<GetRoute>(async (waypoints) => {
      if (waypoints[0][0] === COLOGNE[0]) throw new Error("leg unavailable");
      return resultOf(waypoints);
    });
    const backup = vi.fn<GetRoute>(async (waypoints) => resultOf(waypoints));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { arriveBy: "2026-09-01T16:00" }, null],
        arriveBy: "2026-09-01T18:00",
      }),
      [
        provider({ id: "valhalla", temporal: NATIVE_DWELL }, primary),
        provider({ id: "osrm", temporal: APPROXIMATE }, backup),
      ],
    );
    expect(result.provider).toBe("osrm");
    expect(result.temporal).toEqual(APPROXIMATE);
    expect(result.fidelity).toBe("approximate");
    expect(result.routes[0].legs).toHaveLength(2);
  });
  it.each([false, true])(
    "does not downgrade a native result for an unused approximate backup (windows: %s)",
    async (windows) => {
      const primary = vi.fn<GetRoute>(async (waypoints) => resultOf(waypoints));
      const backup = vi.fn<GetRoute>(async (waypoints) => resultOf(waypoints));
      const request = windows
        ? windowedRequest()
        : parseScheduleRequest({
            waypoints: [COLOGNE, BONN, AACHEN],
            schedules: [null, { dwellSeconds: 600 }, null],
            departAt: "2026-09-01T09:00",
          });
      const result = await runSchedulePlan(request, [
        provider({ id: "valhalla", temporal: NATIVE_DWELL }, primary),
        provider({ id: "osrm", temporal: APPROXIMATE }, backup),
      ]);
      expect(backup).not.toHaveBeenCalled();
      expect(result.fidelity).toBe("exact");
      expect(result.temporal).toEqual(NATIVE_DWELL);
      expect(
        result.warnings.filter((warning) => warning.kind === "approximate-travel-times"),
      ).toEqual([]);
    },
  );

  it("attributes a retained approximate single-call fallback to its actual provider", async () => {
    const primary = vi.fn<GetRoute>(async () => {
      throw new Error("native unavailable");
    });
    const backup = vi.fn<GetRoute>(async (waypoints) => resultOf(waypoints));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { dwellSeconds: 600 }, null],
        departAt: "2026-09-01T09:00",
      }),
      [
        provider({ id: "valhalla", temporal: NATIVE_DWELL }, primary),
        provider({ id: "osrm", temporal: APPROXIMATE }, backup),
      ],
    );
    expect(backup).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("osrm");
    expect(result.fidelity).toBe("approximate");
    expect(result.temporal).toEqual(APPROXIMATE);
    expect(result.warnings).toContainEqual({
      kind: "approximate-travel-times",
      providerId: "osrm",
    });
    expect(result.warnings).toContainEqual({
      kind: "provider-fallback",
      from: "valhalla",
      to: "osrm",
    });
  });

  it("aggregates mixed retained legs and warns only for the approximate contributor", async () => {
    const primary = vi.fn<GetRoute>(async (waypoints) => {
      if (waypoints[0][0] === BONN[0]) throw new Error("leg unavailable");
      return resultOf(waypoints);
    });
    const backup = vi.fn<GetRoute>(async (waypoints) => resultOf(waypoints));
    const result = await runSchedulePlan(windowedRequest(), [
      provider({ id: "valhalla", temporal: NATIVE_DWELL }, primary),
      provider({ id: "osrm", temporal: APPROXIMATE }, backup),
    ]);
    expect(result.routes[0].legs).toHaveLength(2);
    expect(result.fidelity).toBe("approximate");
    expect(result.temporal).toEqual(APPROXIMATE);
    expect(
      result.warnings.filter((warning) => warning.kind === "approximate-travel-times"),
    ).toEqual([{ kind: "approximate-travel-times", providerId: "osrm" }]);
  });

  it("excludes rejected approximate single-call output from exact retained leg metadata", async () => {
    const primary = vi.fn<GetRoute>(async (waypoints) => {
      if (waypoints.length > 2) throw new Error("single call unavailable");
      return resultOf(waypoints);
    });
    const backup = vi.fn<GetRoute>(async (waypoints) => ({
      waypoints,
      activeRouteIndex: 0,
      routes: [routeOf(3600, waypoints[0], waypoints[waypoints.length - 1])],
    }));
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { dwellSeconds: 600 }, null],
        departAt: "2026-09-01T09:00",
      }),
      [
        provider({ id: "valhalla", temporal: NATIVE_DWELL }, primary),
        provider({ id: "osrm", temporal: APPROXIMATE }, backup),
      ],
    );
    expect(primary).toHaveBeenCalledTimes(3);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(result.routes[0].legs).toHaveLength(2);
    expect(result.provider).toBe("valhalla");
    expect(result.fidelity).toBe("exact");
    expect(result.temporal).toEqual(NATIVE_DWELL);
    expect(
      result.warnings.filter((warning) => warning.kind === "approximate-travel-times"),
    ).toEqual([]);
    expect(result.warnings).toContainEqual({
      kind: "provider-fallback",
      from: "valhalla",
      to: "osrm",
    });
  });

  it.each(["forward", "backward"])(
    "keeps metadata from the retained exact %s partial route",
    async (direction) => {
      const request =
        direction === "forward"
          ? windowedRequest()
          : parseScheduleRequest({
              waypoints: [COLOGNE, BONN, AACHEN],
              schedules: [null, { arriveBy: "2026-09-01T16:00" }, null],
              arriveBy: "2026-09-01T18:00",
            });
      const primary = vi.fn<GetRoute>(async (waypoints) => {
        if (waypoints[0][0] === (direction === "forward" ? BONN[0] : COLOGNE[0]))
          throw new Error("unreachable");
        return resultOf(waypoints);
      });
      const backup = vi.fn<GetRoute>(async () => {
        throw new Error("unreachable");
      });
      const result = await runSchedulePlan(request, [
        provider({ id: "valhalla", temporal: NATIVE_DWELL }, primary),
        provider({ id: "osrm", temporal: APPROXIMATE }, backup),
      ]);
      expect(result.routes[0].legs).toHaveLength(1);
      expect(result.schedule.violations).toContainEqual({
        kind: "unreachable",
        fromIndex: direction === "forward" ? 1 : 0,
        toIndex: direction === "forward" ? 2 : 1,
      });
      expect(result.provider).toBe("valhalla");
      expect(result.fidelity).toBe("exact");
      expect(result.temporal).toEqual(NATIVE_DWELL);
      expect(
        result.warnings.filter((warning) => warning.kind === "approximate-travel-times"),
      ).toEqual([]);
    },
  );

  it("does not advertise any serving provider or support when every leg is unreachable", async () => {
    const dead = vi.fn<GetRoute>(async () => {
      throw new Error("unreachable");
    });
    const result = await runSchedulePlan(windowedRequest(), [
      provider({ id: "valhalla", temporal: NATIVE_DWELL }, dead),
      provider({ id: "osrm", temporal: APPROXIMATE }, dead),
    ]);
    expect(result.routes).toEqual([]);
    expect(result.provider).toBeUndefined();
    expect(Object.values(result.temporal)).toEqual(Array(6).fill("unsupported"));
    expect(
      result.warnings.filter((warning) => warning.kind === "approximate-travel-times"),
    ).toEqual([]);
  });
});

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
