import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { DirectionsResult, Route } from "../../types/routing";
import {
  evaluateRouteStopDetours,
  insertRouteStop,
  remainingRouteStopWaypoints,
  routeStopWaypointPositions,
} from "../routeStopDetours";

const O: LngLat = [0, 0],
  W: LngLat = [0.001, 0],
  D: LngLat = [0.002, 0];
const urban: LngLat = [0.0012, 0.0001],
  motorway: LngLat = [0.0014, -0.0001];
const river: LngLat = [0.0013, 0.0002],
  restricted: LngLat = [0.0016, 0.0001];
const route = { geometry: [O, W, D], distance: 2000, duration: 200 } as Route;
// A directed road graph, specified independently of geometry/projection code.
// The other carriageway can only be entered by driving to D and returning to W.
const edges: [LngLat, LngLat, number, number][] = [
  [O, W, 100, 1000],
  [W, D, 100, 1000],
  [W, urban, 10, 50],
  [urban, W, 10, 50],
  [D, motorway, 600, 6000],
  [motorway, W, 600, 6000],
  [W, river, 300, 2000],
  [river, W, 300, 2000],
];
function graphRoute(points: LngLat[]): DirectionsResult {
  let duration = 0,
    distance = 0;
  for (let i = 1; i < points.length; i++) {
    const pending = [{ point: points[i - 1], seconds: 0, metres: 0 }];
    const visited = new Set<string>();
    let reached = false;
    while (pending.length) {
      pending.sort((a, b) => a.seconds - b.seconds);
      const next = pending.shift()!;
      const key = next.point.join(",");
      if (visited.has(key)) continue;
      visited.add(key);
      if (key === points[i].join(",")) {
        duration += next.seconds;
        distance += next.metres;
        reached = true;
        break;
      }
      for (const [from, to, seconds, metres] of edges) {
        if (from.join(",") === key)
          pending.push({
            point: to,
            seconds: next.seconds + seconds,
            metres: next.metres + metres,
          });
      }
    }
    if (!reached)
      return { routes: [], waypoints: points, activeRouteIndex: 0, provider: "routing-fixture" };
  }
  return {
    routes: [{ ...route, duration, distance }],
    waypoints: points,
    activeRouteIndex: 0,
    provider: "routing-fixture",
  };
}
const input = {
  route: route.geometry,
  waypoints: [O, W, D],
  provider: "routing-fixture",
  signal: new AbortController().signal,
};

describe("remaining-itinerary stop detours", () => {
  it("retains a later visit to a waypoint on a route that doubles back", () => {
    const a: LngLat = [0.02, 0],
      b: LngLat = [0.01, 0],
      d: LngLat = [0.03, 0];
    const geometry: LngLat[] = [O, b, a, b, d];
    const positions = routeStopWaypointPositions(geometry, [O, a, b, d]);
    expect(positions[0].alongMeters).toBeCloseTo(2223.9, 0);
    expect(positions[1].alongMeters).toBeCloseTo(3335.9, 0);
    expect(remainingRouteStopWaypoints(positions, [0.0135, 0], 1500)).toEqual([
      [0.0135, 0],
      a,
      b,
      d,
    ]);
    expect(insertRouteStop(geometry, [[0.0135, 0], a, b, d], [0.019, 0])).toEqual([
      [0.0135, 0],
      [0.019, 0],
      a,
      b,
      d,
    ]);
  });
  it("keeps user waypoint order while inserting at the candidate's route segment", () => {
    expect(insertRouteStop(route.geometry, [O, W, D], [0.0005, 0.0001])).toEqual([
      O,
      [0.0005, 0.0001],
      W,
      D,
    ]);
    expect(insertRouteStop(route.geometry, [O, W, D], urban)).toEqual([O, W, urban, D]);
  });
  it("uses independent road access rather than perpendicular-distance minutes", async () => {
    const results = await evaluateRouteStopDetours({
      ...input,
      candidates: [urban, motorway, river, restricted].map((coordinates, id) => ({
        id: String(id),
        coordinates,
      })),
      requestRoute: async ({ waypoints }) => graphRoute(waypoints),
    });
    expect(
      results.map((r) =>
        r.kind === "network" ? [r.kind, r.seconds, r.meters] : [r.kind, undefined, undefined],
      ),
    ).toEqual([
      ["network", 20, 100],
      ["network", 1300, 13000],
      ["network", 600, 4000],
      ["unreachable", undefined, undefined],
    ]);
  });
  it("uses a supplied entrance and retains its identity distinct from the centroid", async () => {
    const [result] = await evaluateRouteStopDetours({
      ...input,
      candidates: [{ id: "entrance", coordinates: restricted, routingEntrance: urban }],
      requestRoute: async ({ waypoints }) => graphRoute(waypoints),
    });
    expect(result).toMatchObject({
      kind: "network",
      seconds: 20,
      access: { kind: "entrance", coordinates: urban },
    });
    expect(result.waypoints).toEqual([O, W, urban, D]);
  });
  it("labels missing provider evidence and invalid metrics as unknown", async () => {
    for (const response of [
      { ...graphRoute([O, W, D]), provider: "other" },
      { ...graphRoute([O, W, D]), routes: [{ ...route, duration: NaN }] },
    ]) {
      const [result] = await evaluateRouteStopDetours({
        ...input,
        candidates: [{ id: "u", coordinates: urban }],
        requestRoute: async () => response,
      });
      expect(result.kind).toBe("unknown");
    }
  });
  it("bounds the shortlist and concurrent routing work", async () => {
    let active = 0,
      peak = 0,
      calls = 0;
    const results = await evaluateRouteStopDetours({
      ...input,
      candidates: Array.from({ length: 20 }, (_, id) => ({ id: String(id), coordinates: urban })),
      requestRoute: async ({ waypoints, provider }) => {
        expect(provider).toBe("routing-fixture");
        calls++;
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return graphRoute(waypoints);
      },
    });
    expect(results).toHaveLength(6);
    expect(calls).toBe(7);
    expect(peak).toBe(2);
  });
  it("does not issue candidate requests after baseline failure or cancellation", async () => {
    let calls = 0;
    const [result] = await evaluateRouteStopDetours({
      ...input,
      candidates: [{ id: "u", coordinates: urban }],
      requestRoute: async () => {
        calls++;
        throw new Error("offline");
      },
    });
    expect(result.kind).toBe("unknown");
    expect(calls).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      evaluateRouteStopDetours({
        ...input,
        signal: controller.signal,
        candidates: [{ id: "u", coordinates: urban }],
        requestRoute: async () => {
          calls++;
          return graphRoute([O, D]);
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
