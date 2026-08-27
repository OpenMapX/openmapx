import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, streamedJsonResponse } from "../../test/streamed-response.js";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    decodePolyline: vi.fn(() => [
      [13.388, 52.517],
      [13.392, 52.521],
      [13.397, 52.529],
      [13.405, 52.535],
    ]),
  };
});

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOk(data: unknown) {
  return streamedJsonResponse(data);
}

function mockNotOk(status = 500) {
  return emptyResponse(status);
}

function makeManeuver(overrides: Record<string, unknown> = {}) {
  return {
    type: 1,
    instruction: "Walk east on Friedrichstraße.",
    length: 0.5,
    time: 360,
    begin_shape_index: 0,
    end_shape_index: 2,
    ...overrides,
  };
}

function makeLeg(overrides: Record<string, unknown> = {}) {
  return {
    shape: "encoded_polyline_data",
    summary: { length: 1.2, time: 900 },
    maneuvers: [
      makeManeuver(),
      makeManeuver({
        type: 6,
        instruction: "Turn right onto Torstraße.",
        length: 0.7,
        time: 540,
        begin_shape_index: 2,
        end_shape_index: 3,
        street_names: ["Torstraße"],
      }),
    ],
    ...overrides,
  };
}

function makeTrip(overrides: Record<string, unknown> = {}) {
  return {
    summary: { length: 1.2, time: 900 },
    legs: [makeLeg()],
    ...overrides,
  };
}

function makeValhallaResponse(overrides: Record<string, unknown> = {}) {
  return {
    trip: makeTrip(),
    ...overrides,
  };
}

const origin: [number, number] = [13.388, 52.517];
const destination: [number, number] = [13.405, 52.535];
const waypoints: [number, number][] = [origin, destination];

describe("valhallaService", () => {
  describe("route()", () => {
    it("uses costing 'pedestrian' for walking", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.costing).toBe("pedestrian");
    });

    it("uses costing 'bicycle' for cycling", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "cycling");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.costing).toBe("bicycle");
    });

    it("converts distance from km to metres", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");
      const route = result.routes[0];

      expect(route.distance).toBe(1200); // 1.2 * 1000
    });

    it("keeps duration as seconds from summary.time", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");
      const route = result.routes[0];

      expect(route.duration).toBe(900);
    });

    it("concatenates elevation from all legs when present", async () => {
      const resp = makeValhallaResponse({
        trip: makeTrip({
          legs: [makeLeg({ elevation: [100, 105, 110] }), makeLeg({ elevation: [110, 115, 120] })],
        }),
      });
      mockFetch.mockResolvedValueOnce(mockOk(resp));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");
      const route = result.routes[0];

      expect(route.elevation).toEqual([100, 105, 110, 110, 115, 120]);
      expect(route.elevationInterval).toBe(30);
    });

    it("returns undefined elevation when no leg has elevation data", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");
      const route = result.routes[0];

      expect(route.elevation).toBeUndefined();
      expect(route.elevationInterval).toBeUndefined();
    });

    it("builds summary from first named maneuver's street_names", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");
      const route = result.routes[0];

      // The second maneuver has street_names: ["Torstraße"]
      expect(route.summary).toBe("via Torstraße");
    });

    it("returns undefined summary when no maneuver has street_names", async () => {
      const resp = makeValhallaResponse({
        trip: makeTrip({
          legs: [
            makeLeg({
              maneuvers: [
                makeManeuver(), // no street_names
              ],
            }),
          ],
        }),
      });
      mockFetch.mockResolvedValueOnce(mockOk(resp));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");

      expect(result.routes[0].summary).toBeUndefined();
    });

    it("includes alternatives from data.alternates", async () => {
      const resp = makeValhallaResponse({
        alternates: [
          { trip: makeTrip({ summary: { length: 2.0, time: 1500 } }) },
          { trip: makeTrip({ summary: { length: 2.5, time: 1800 } }) },
        ],
      });
      mockFetch.mockResolvedValueOnce(mockOk(resp));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");

      expect(result.routes).toHaveLength(3);
      expect(result.routes[0].distance).toBe(1200);
      expect(result.routes[1].distance).toBe(2000);
      expect(result.routes[2].distance).toBe(2500);
    });

    it("sets avoidHighways -> use_highways=0 in costing_options", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "cycling", {
        avoidHighways: true,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.costing_options.bicycle.use_highways).toBe(0);
    });

    it("sets avoidFerries -> use_ferry=0 in costing_options", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking", {
        avoidFerries: true,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.costing_options.pedestrian.use_ferry).toBe(0);
    });

    it("maps imperial units to 'miles' in the request", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking", {
        units: "imperial",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.directions_options.units).toBe("miles");
    });

    it("maps metric units to 'km' in the request", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking", {
        units: "metric",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.directions_options.units).toBe("km");
    });

    it("converts step distance from km to metres", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");
      const step = result.routes[0].steps[0];

      expect(step.distance).toBe(500); // 0.5 * 1000
    });

    it("slices step coordinates by shape indices", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");

      // First maneuver: begin=0, end=2 -> slice(0, 3)
      const step0 = result.routes[0].steps[0];
      expect(step0.coordinates).toEqual([
        [13.388, 52.517],
        [13.392, 52.521],
        [13.397, 52.529],
      ]);

      // Second maneuver: begin=2, end=3 -> slice(2, 4)
      const step1 = result.routes[0].steps[1];
      expect(step1.coordinates).toEqual([
        [13.397, 52.529],
        [13.405, 52.535],
      ]);
    });

    it("sends POST request to VALHALLA_URL/route", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking");

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/route");

      const options = mockFetch.mock.calls[0][1] as RequestInit;
      expect(options.method).toBe("POST");
      expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(503));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");

      await expect(valhallaService.getRoute(waypoints, "walking")).rejects.toThrow(
        "Valhalla error 503",
      );
    });

    it("returns correct waypoints and activeRouteIndex", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");

      expect(result.waypoints).toEqual(waypoints);
      expect(result.activeRouteIndex).toBe(0);
    });

    it("passes language in directions_options", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking", { lang: "de" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.directions_options.language).toBe("de");
    });

    it("defaults language to 'en'", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.directions_options.language).toBe("en");
    });

    it("includes elevation_interval and alternates in request body for 2 waypoints", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.elevation_interval).toBe(30);
      expect(body.alternates).toBe(2);
    });

    it("defaults date_time to type 0 (current departure) when no time given", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "driving");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.date_time).toEqual({ type: 0 });
    });

    it("sets date_time type 1 with value when departAt is given", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "driving", { departAt: "2026-05-04T08:30" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.date_time).toEqual({ type: 1, value: "2026-05-04T08:30" });
    });

    it("sets date_time type 2 with value when arriveBy is given", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "driving", { arriveBy: "2026-05-04T17:00" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.date_time).toEqual({ type: 2, value: "2026-05-04T17:00" });
    });

    it("throws when both departAt and arriveBy are set", async () => {
      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");

      await expect(
        valhallaService.getRoute(waypoints, "driving", {
          departAt: "2026-05-04T08:30",
          arriveBy: "2026-05-04T17:00",
        }),
      ).rejects.toThrow("departAt and arriveBy are mutually exclusive");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not request alternates with 3+ waypoints", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const threeWaypoints: [number, number][] = [origin, [13.395, 52.525], destination];
      await valhallaService.getRoute(threeWaypoints, "walking");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.alternates).toBeUndefined();
    });

    it("sets locations with type 'break' and correct lon/lat from waypoints", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getRoute(waypoints, "walking");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.locations).toEqual([
        { lon: 13.388, lat: 52.517, type: "break" },
        { lon: 13.405, lat: 52.535, type: "break" },
      ]);
    });

    it("sets route mode to the travel mode passed in", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "cycling");

      expect(result.routes[0].mode).toBe("cycling");
    });

    it("produces legs array with per-leg data", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeValhallaResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getRoute(waypoints, "walking");
      const route = result.routes[0];

      expect(route.legs).toHaveLength(1);
      expect(route.legs[0].distance).toBe(1200);
      expect(route.legs[0].duration).toBe(900);
      expect(route.legs[0].steps.length).toBeGreaterThan(0);
      expect(route.legs[0].geometry.length).toBeGreaterThan(0);
    });
  });

  describe("optimizeRoute()", () => {
    const fourWaypoints: [number, number][] = [
      origin,
      [13.395, 52.525],
      [13.4, 52.53],
      destination,
    ];

    function makeOptimizeResponse(overrides: Record<string, unknown> = {}) {
      return makeValhallaResponse({
        trip: makeTrip({
          locations: [
            { lat: 52.517, lon: 13.388, original_index: 0 },
            { lat: 52.53, lon: 13.4, original_index: 2 },
            { lat: 52.525, lon: 13.395, original_index: 1 },
            { lat: 52.535, lon: 13.405, original_index: 3 },
          ],
          ...overrides,
        }),
      });
    }

    it("calls /optimized_route endpoint", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOptimizeResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.optimizeRoute?.(fourWaypoints, "walking");

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/optimized_route");
    });

    it("extracts optimizedOrder from locations[].original_index", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOptimizeResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.optimizeRoute?.(fourWaypoints, "walking");

      expect(result?.optimizedOrder).toEqual([0, 2, 1, 3]);
    });

    it("falls back to sequential order when locations have no original_index", async () => {
      const resp = makeValhallaResponse({
        trip: makeTrip({ locations: undefined }),
      });
      mockFetch.mockResolvedValueOnce(mockOk(resp));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.optimizeRoute?.(fourWaypoints, "walking");

      expect(result?.optimizedOrder).toEqual([0, 1, 2, 3]);
    });

    it("returns routes from the trip", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOptimizeResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.optimizeRoute?.(fourWaypoints, "walking");

      expect(result?.routes).toHaveLength(1);
      expect(result?.routes[0].mode).toBe("walking");
    });

    it("uses correct costing for driving mode", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOptimizeResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.optimizeRoute?.(fourWaypoints, "driving");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.costing).toBe("auto");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(504));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");

      await expect(valhallaService.optimizeRoute?.(fourWaypoints, "cycling")).rejects.toThrow(
        "Valhalla optimized_route error 504",
      );
    });

    it("sets all locations with type 'break'", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOptimizeResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.optimizeRoute?.(fourWaypoints, "walking");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      for (const loc of body.locations) {
        expect(loc.type).toBe("break");
      }
    });

    it("defaults date_time to type 0 when no time given", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOptimizeResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.optimizeRoute?.(fourWaypoints, "driving");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.date_time).toEqual({ type: 0 });
    });

    it("threads departAt into date_time type 1", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOptimizeResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.optimizeRoute?.(fourWaypoints, "driving", {
        departAt: "2026-05-04T08:30",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.date_time).toEqual({ type: 1, value: "2026-05-04T08:30" });
    });
  });

  describe("getMatch()", () => {
    const trace = [
      { lat: 52.517, lng: 13.388 },
      { lat: 52.521, lng: 13.392 },
      { lat: 52.529, lng: 13.397 },
    ];

    function makeTraceResponse(overrides: Record<string, unknown> = {}) {
      return {
        shape: "encoded_polyline_data",
        edges: [
          {
            way_id: 12345,
            length: 0.5, // km
            speed: 50,
            surface: "paved",
            names: ["Friedrichstraße"],
            begin_shape_index: 0,
            end_shape_index: 2,
          },
        ],
        matched_points: [
          {
            lat: 52.517,
            lon: 13.388,
            type: "matched",
            edge_index: 0,
            distance_along_edge: 0.05, // 0–1 ratio along the matched edge
            distance_from_trace_point: 4.2, // metres
          },
        ],
        ...overrides,
      };
    }

    it("POSTs to VALHALLA_URL/trace_attributes with shape + filters + walk_or_snap default", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeTraceResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getMatch?.(trace, "driving");

      const url = mockFetch.mock.calls[0][0] as string;
      const init = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);

      expect(url).toContain("/trace_attributes");
      expect(init.method).toBe("POST");
      expect(body.shape).toEqual([
        { lat: 52.517, lon: 13.388 },
        { lat: 52.521, lon: 13.392 },
        { lat: 52.529, lon: 13.397 },
      ]);
      expect(body.shape_match).toBe("walk_or_snap");
      expect(body.costing).toBe("auto");
      expect(body.filters.action).toBe("include");
      expect(body.filters.attributes).toEqual(expect.arrayContaining(["edge.way_id", "shape"]));
    });

    it("uses pedestrian costing for walking and bicycle for cycling", async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk(makeTraceResponse()))
        .mockResolvedValueOnce(mockOk(makeTraceResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getMatch?.(trace, "walking");
      await valhallaService.getMatch?.(trace, "cycling");

      const body1 = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body as string);
      expect(body1.costing).toBe("pedestrian");
      expect(body2.costing).toBe("bicycle");
    });

    it("honours an explicit shapeMatch option", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeTraceResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getMatch?.(trace, "driving", { shapeMatch: "map_snap" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.shape_match).toBe("map_snap");
    });

    it("converts ISO timestamps on trace points to unix epoch seconds", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeTraceResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      await valhallaService.getMatch?.(
        [
          { lat: 52.517, lng: 13.388, time: "2026-05-04T08:00:00Z" },
          { lat: 52.521, lng: 13.392, time: "2026-05-04T08:00:30Z" },
        ],
        "driving",
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.shape[0]).toEqual({
        lat: 52.517,
        lon: 13.388,
        time: Math.round(Date.parse("2026-05-04T08:00:00Z") / 1000),
      });
      expect(body.shape[1].time).toBe(Math.round(Date.parse("2026-05-04T08:00:30Z") / 1000));
    });

    it("transforms edges: way_id, length km->metres, names, shape indices", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeTraceResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getMatch?.(trace, "driving");
      const edge = result?.edges[0];

      expect(edge?.wayId).toBe(12345);
      expect(edge?.length).toBe(500); // 0.5 km -> 500 m
      expect(edge?.speed).toBe(50);
      expect(edge?.surface).toBe("paved");
      expect(edge?.names).toEqual(["Friedrichstraße"]);
      expect(edge?.beginShapeIndex).toBe(0);
      expect(edge?.endShapeIndex).toBe(2);
    });

    it("transforms matched_points: lon->lng, distance_along_edge passed through as ratio", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeTraceResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getMatch?.(trace, "driving");
      const point = result?.points[0];

      expect(point?.lng).toBe(13.388);
      expect(point?.lat).toBe(52.517);
      expect(point?.type).toBe("matched");
      expect(point?.edgeIndex).toBe(0);
      // Valhalla returns this as a 0–1 ratio along the edge; we pass it through
      // unchanged so consumers can multiply by edges[edgeIndex].length themselves.
      expect(point?.distanceAlongEdgeRatio).toBe(0.05);
      expect(point?.distanceFromTracePoint).toBe(4.2);
    });

    it("returns the decoded polyline as geometry and mode in the result", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeTraceResponse()));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getMatch?.(trace, "cycling");

      expect(result?.mode).toBe("cycling");
      // decodePolyline is module-mocked at the top of the file to a fixed shape.
      expect(result?.geometry).toEqual([
        [13.388, 52.517],
        [13.392, 52.521],
        [13.397, 52.529],
        [13.405, 52.535],
      ]);
    });

    it("returns empty arrays when Valhalla omits shape / edges / matched_points", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({}));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");
      const result = await valhallaService.getMatch?.(trace, "driving");

      expect(result?.geometry).toEqual([]);
      expect(result?.edges).toEqual([]);
      expect(result?.points).toEqual([]);
    });

    it("throws when the trace has fewer than 2 points", async () => {
      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");

      await expect(valhallaService.getMatch?.([{ lat: 1, lng: 2 }], "driving")).rejects.toThrow(
        "trace requires at least 2 points",
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(500));

      const { valhallaService } = await import("@integrations/routing-valhalla/provider.js");

      await expect(valhallaService.getMatch?.(trace, "driving")).rejects.toThrow(
        "Valhalla trace_attributes error 500",
      );
    });
  });
});
