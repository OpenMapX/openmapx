import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LngLat } from "../types/geometry";
import type { MatchResult } from "../types/routing";
import { configureApiClient } from "./client";
import { fetchRouteMatchWindow } from "./routeAttributes";

const trace: LngLat[] = [
  [6.086047, 50.776993],
  [6.086282, 50.777161],
  [6.088038, 50.778025],
];

const matched: MatchResult = {
  mode: "driving",
  provider: "routing-valhalla",
  geometry: [trace[0], trace[1], [6.087297, 50.778288], trace[2]],
  edges: [
    {
      length: 25,
      speedLimit: 30,
      beginShapeIndex: 0,
      endShapeIndex: 1,
      endNodeTrafficSignal: true,
      endNodeCountryCode: "DE",
    },
    { length: 58, beginShapeIndex: 1, endShapeIndex: 2 },
    {
      length: 60,
      speedLimit: 50,
      beginShapeIndex: 2,
      endShapeIndex: 3,
      endNodeCountryCode: "NL",
    },
  ],
  points: [
    { lng: trace[0][0], lat: trace[0][1], type: "matched", edgeIndex: 0 },
    { lng: trace[1][0], lat: trace[1][1], type: "unmatched" },
    { lng: trace[2][0], lat: trace[2][1], type: "matched", edgeIndex: 2 },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchRouteMatchWindow", () => {
  beforeEach(() => configureApiClient({ baseUrl: "https://openmapx.example" }));
  afterEach(() => vi.unstubAllGlobals());

  it("obtains point-aligned limits and countries when edge walking would omit points", async () => {
    // Valhalla's successful edge walk has edges/shape but no matched_points.
    // Exercise the real API client and extraction against that mode contract.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(
          jsonResponse(body.shapeMatch === "map_snap" ? matched : { ...matched, points: [] }),
        );
      }),
    );

    expect(await fetchRouteMatchWindow(trace, "driving")).toEqual({
      signals: [trace[1]],
      speedLimitsByPoint: [30, null, 50],
      countriesByPoint: ["DE", null, "NL"],
    });
  });

  it.each([[], matched.points.slice(0, 2), [...matched.points, matched.points[0]]])(
    "rejects misaligned point attributes while retaining traffic signals (%j)",
    async (points) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...matched, points })));

      expect(await fetchRouteMatchWindow(trace, "driving")).toEqual({
        signals: [trace[1]],
        speedLimitsByPoint: [],
        countriesByPoint: [],
      });
    },
  );

  it("keeps unknown and zero speed limits unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...matched,
          edges: matched.edges.map((edge) => ({ ...edge, speedLimit: 0 })),
        }),
      ),
    );

    expect((await fetchRouteMatchWindow(trace, "driving")).speedLimitsByPoint).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("returns empty attributes on a failed match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unavailable" }, 502)));

    expect(await fetchRouteMatchWindow(trace, "driving")).toEqual({
      signals: [],
      speedLimitsByPoint: [],
      countriesByPoint: [],
    });
  });
});
