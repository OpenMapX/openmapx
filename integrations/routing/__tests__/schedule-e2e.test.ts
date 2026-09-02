import type { DirectionsResult, RoutingOptions, TravelMode } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedProvider } from "../orchestrator.js";
import { runSchedulePlan } from "../schedule-plan.js";
import { parseScheduleRequest } from "../schedule-request.js";
import type { Route } from "../types.js";

const COLOGNE: [number, number] = [6.96, 50.94];
const BONN: [number, number] = [7.1, 50.73];
const AACHEN: [number, number] = [6.08, 50.77];
const NEW_YORK: [number, number] = [-74.01, 40.71];

const HOUR = 3600;

function fixedRoute(seconds: number, waypoints: [number, number][]): Route {
  const legCount = waypoints.length - 1;
  return {
    distance: legCount * seconds * 15,
    duration: legCount * seconds,
    geometry: waypoints,
    legs: waypoints.slice(1).map((point, index) => ({
      distance: seconds * 15,
      duration: seconds,
      geometry: [waypoints[index], point],
      steps: [],
    })),
    steps: [],
    mode: "driving",
  };
}

/** A provider whose every leg takes a fixed number of seconds. */
function fixedProvider(seconds: number, id = "valhalla"): ResolvedProvider {
  return {
    integrationId: id,
    provider: {
      id,
      supportedModes: ["driving"] as TravelMode[],
      supportsTimeAware: true,
      async getRoute(waypoints: [number, number][]): Promise<DirectionsResult> {
        return { waypoints, routes: [fixedRoute(seconds, waypoints)], activeRouteIndex: 0 };
      },
    } as unknown as ResolvedProvider["provider"],
  };
}

describe("scheduled directions end to end", () => {
  it("keeps elapsed time honest across a spring-forward transition", async () => {
    // 2027-03-28 01:30 CET + 2 h elapsed is 04:30 CEST: the clock skips 02:00 → 03:00.
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN],
        schedules: [null, null],
        departAt: "2027-03-28T01:30",
      }),
      [fixedProvider(2 * HOUR)],
    );
    expect(result.schedule.departure).toBe("2027-03-28T01:30:00+01:00");
    expect(result.schedule.arrival).toBe("2027-03-28T04:30:00+02:00");
  });

  it("resolves a departure inside the spring-forward gap to the first valid instant", async () => {
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN],
        schedules: [{ departAfter: "2027-03-28T02:30" }, null],
        departAt: "2027-03-28T00:00",
      }),
      [fixedProvider(HOUR)],
    );
    expect(result.schedule.departure).toBe("2027-03-28T03:00:00+02:00");
  });

  it("crosses a time-zone boundary and renders each end in its own zone", async () => {
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, NEW_YORK],
        schedules: [null, null],
        departAt: "2026-09-01T09:00",
      }),
      [fixedProvider(8 * HOUR)],
    );
    expect(result.schedule.departure).toBe("2026-09-01T09:00:00+02:00");
    expect(result.schedule.arrival).toBe("2026-09-01T11:00:00-04:00");
    expect(result.schedule.multiDay).toBe(false);
  });

  it("spans several days with long dwells and totals correctly", async () => {
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN, COLOGNE],
        schedules: [null, { dwellSeconds: 12 * HOUR }, { dwellSeconds: 12 * HOUR }, null],
        departAt: "2026-09-01T09:00",
      }),
      [fixedProvider(6 * HOUR)],
    );
    expect(result.schedule.multiDay).toBe(true);
    expect(result.schedule.totalTravelSeconds).toBe(18 * HOUR);
    expect(result.schedule.totalDwellSeconds).toBe(24 * HOUR);
    expect(result.schedule.arrival).toBe("2026-09-03T03:00:00+02:00");
  });

  it("crosses midnight on a single leg", async () => {
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN],
        schedules: [null, null],
        departAt: "2026-09-01T22:00",
      }),
      [fixedProvider(4 * HOUR)],
    );
    expect(result.schedule.arrival).toBe("2026-09-02T02:00:00+02:00");
    expect(result.schedule.multiDay).toBe(true);
  });

  it("reports an impossible appointment with the waypoint and the shortfall", async () => {
    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { fixedAt: "2026-09-01T09:30" }, null],
        departAt: "2026-09-01T09:00",
      }),
      [fixedProvider(HOUR)],
    );
    expect(result.schedule.violations).toContainEqual({
      kind: "late-arrival",
      waypointIndex: 1,
      requiredBy: "2026-09-01T09:30:00+02:00",
      earliestArrival: "2026-09-01T10:00:00+02:00",
      shortfallSeconds: 1800,
    });
  });

  it("treats zero dwell as distinct from absent dwell without changing the schedule", async () => {
    const withZero = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { dwellSeconds: 0 }, null],
        departAt: "2026-09-01T09:00",
      }),
      [fixedProvider(HOUR)],
    );
    const without = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, null, null],
        departAt: "2026-09-01T09:00",
      }),
      [fixedProvider(HOUR)],
    );
    expect(withZero.schedule.arrival).toBe(without.schedule.arrival);
  });

  it("falls back to the next provider mid-chain and still produces one route", async () => {
    const failing: ResolvedProvider = {
      integrationId: "valhalla",
      provider: {
        id: "valhalla",
        supportedModes: ["driving"] as TravelMode[],
        supportsTimeAware: true,
        getRoute: vi.fn(
          async (
            waypoints: [number, number][],
            _mode: TravelMode,
            _options?: RoutingOptions,
          ): Promise<DirectionsResult> => {
            if (waypoints[0][0] === BONN[0]) throw new Error("engine down");
            return { waypoints, routes: [fixedRoute(HOUR, waypoints)], activeRouteIndex: 0 };
          },
        ),
      } as unknown as ResolvedProvider["provider"],
    };

    const result = await runSchedulePlan(
      parseScheduleRequest({
        waypoints: [COLOGNE, BONN, AACHEN],
        schedules: [null, { departAfter: "2026-09-01T12:00" }, null],
        departAt: "2026-09-01T09:00",
      }),
      [failing, fixedProvider(2 * HOUR, "osrm")],
    );

    expect(result.warnings).toContainEqual({
      kind: "provider-fallback",
      from: "valhalla",
      to: "osrm",
    });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].legs).toHaveLength(2);
    expect(result.schedule.violations).toEqual([]);
  });
});
