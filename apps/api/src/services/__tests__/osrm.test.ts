import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk(status = 500) {
  return { ok: false, status } as Response;
}

async function loadModule() {
  return import("../osrm.service.js");
}

function makeStep(overrides: Record<string, unknown> = {}) {
  return {
    distance: 150,
    duration: 12,
    name: "Main St",
    maneuver: {
      type: "turn",
      modifier: "left",
      location: [13.39, 52.52],
    },
    geometry: {
      type: "LineString",
      coordinates: [
        [13.39, 52.52],
        [13.4, 52.53],
      ],
    },
    ...overrides,
  };
}

function makeOsrmRoute(overrides: Record<string, unknown> = {}) {
  return {
    distance: 12500,
    duration: 840,
    geometry: {
      type: "LineString",
      coordinates: [
        [13.388, 52.517],
        [13.397, 52.529],
        [13.405, 52.535],
      ],
    },
    legs: [
      {
        summary: "Friedrichstraße",
        distance: 12500,
        duration: 840,
        steps: [
          makeStep({ maneuver: { type: "depart", location: [13.388, 52.517] } }),
          makeStep(),
          makeStep({
            name: "Torstraße",
            ref: "B2",
            maneuver: { type: "merge", location: [13.4, 52.53] },
          }),
          makeStep({
            maneuver: { type: "arrive", location: [13.405, 52.535] },
          }),
        ],
      },
    ],
    ...overrides,
  };
}

function makeOsrmResponse(overrides: Record<string, unknown> = {}) {
  return {
    code: "Ok",
    routes: [makeOsrmRoute()],
    ...overrides,
  };
}

const origin: [number, number] = [13.388, 52.517];
const destination: [number, number] = [13.405, 52.535];
const waypoints: [number, number][] = [origin, destination];

describe("osrmService", () => {
  describe("route()", () => {
    it("transforms OSRM response to DirectionsResult", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      const result = await osrmService.route(waypoints);

      expect(result.waypoints).toEqual(waypoints);
      expect(result.activeRouteIndex).toBe(0);
      expect(result.routes).toHaveLength(1);
    });

    it("maps route distance, duration, geometry, and mode", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      const result = await osrmService.route(waypoints);
      const route = result.routes[0];

      expect(route.distance).toBe(12500);
      expect(route.duration).toBe(840);
      expect(route.geometry).toEqual([
        [13.388, 52.517],
        [13.397, 52.529],
        [13.405, 52.535],
      ]);
      expect(route.mode).toBe("driving");
    });

    it("builds summary as 'via [leg.summary]'", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      const result = await osrmService.route(waypoints);

      expect(result.routes[0].summary).toBe("via Friedrichstraße");
    });

    it("returns undefined summary when leg summary is empty", async () => {
      const osrmResp = makeOsrmResponse();
      (osrmResp.routes as Array<Record<string, unknown>>)[0] = makeOsrmRoute({
        legs: [
          {
            summary: "",
            distance: 12500,
            duration: 840,
            steps: [makeStep()],
          },
        ],
      });
      mockFetch.mockResolvedValueOnce(mockOk(osrmResp));

      const { osrmService } = await loadModule();
      const result = await osrmService.route(waypoints);

      expect(result.routes[0].summary).toBeUndefined();
    });

    it("maps multiple alternatives", async () => {
      const resp = makeOsrmResponse({
        routes: [
          makeOsrmRoute({ distance: 12500 }),
          makeOsrmRoute({ distance: 15000 }),
          makeOsrmRoute({ distance: 18000 }),
        ],
      });
      mockFetch.mockResolvedValueOnce(mockOk(resp));

      const { osrmService } = await loadModule();
      const result = await osrmService.route(waypoints);

      expect(result.routes).toHaveLength(3);
      expect(result.routes[0].distance).toBe(12500);
      expect(result.routes[1].distance).toBe(15000);
      expect(result.routes[2].distance).toBe(18000);
    });

    it("sends exclude=motorway when avoidHighways is set", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      await osrmService.route(waypoints, { avoidHighways: true });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("exclude=motorway");
    });

    it("sends exclude=toll when avoidTolls is set", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      await osrmService.route(waypoints, { avoidTolls: true });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("exclude=toll");
    });

    it("sends exclude=ferry when avoidFerries is set", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      await osrmService.route(waypoints, { avoidFerries: true });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("exclude=ferry");
    });

    it("combines multiple exclude values", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      await osrmService.route(waypoints, {
        avoidHighways: true,
        avoidTolls: true,
        avoidFerries: true,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("exclude=motorway%2Ctoll%2Cferry");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(503));

      const { osrmService } = await loadModule();

      await expect(osrmService.route(waypoints)).rejects.toThrow("OSRM error 503");
    });

    it("throws when code is not Ok", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ code: "NoRoute", routes: [] }));

      const { osrmService } = await loadModule();

      await expect(osrmService.route(waypoints)).rejects.toThrow("OSRM returned no routes");
    });

    it("throws when routes array is empty", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ code: "Ok", routes: [] }));

      const { osrmService } = await loadModule();

      await expect(osrmService.route(waypoints)).rejects.toThrow("OSRM returned no routes");
    });

    it("produces legs array with per-leg steps and geometry", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      const result = await osrmService.route(waypoints);
      const route = result.routes[0];

      expect(route.legs).toHaveLength(1);
      expect(route.legs[0].distance).toBe(12500);
      expect(route.legs[0].duration).toBe(840);
      expect(route.legs[0].summary).toBe("via Friedrichstraße");
      expect(route.legs[0].steps.length).toBeGreaterThan(0);
      expect(route.legs[0].geometry.length).toBeGreaterThan(0);
    });

    it("does not request alternatives with 3+ waypoints", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      const threeWaypoints: [number, number][] = [origin, [13.395, 52.525], destination];
      await osrmService.route(threeWaypoints);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).not.toContain("alternatives");
    });

    it("requests alternatives=3 with exactly 2 waypoints", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      await osrmService.route(waypoints);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("alternatives=3");
    });
  });

  describe("instruction generation", () => {
    function buildResponseWithStep(step: Record<string, unknown>) {
      return makeOsrmResponse({
        routes: [
          makeOsrmRoute({
            legs: [
              {
                summary: "",
                distance: 100,
                duration: 10,
                steps: [
                  {
                    distance: 100,
                    duration: 10,
                    name: step.name ?? "Main St",
                    ref: step.ref,
                    maneuver: step.maneuver ?? {
                      type: "turn",
                      modifier: "left",
                      location: [0, 0],
                    },
                    geometry: {
                      type: "LineString",
                      coordinates: [[0, 0]],
                    },
                  },
                ],
              },
            ],
          }),
        ],
      });
    }

    async function getInstruction(step: Record<string, unknown>): Promise<string> {
      mockFetch.mockResolvedValueOnce(mockOk(buildResponseWithStep(step)));
      const { osrmService } = await loadModule();
      const result = await osrmService.route(waypoints);
      return result.routes[0].steps[0].instruction;
    }

    it("depart → 'Head onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "Berliner Straße",
        maneuver: { type: "depart", location: [0, 0] },
      });
      expect(instruction).toBe("Head onto Berliner Straße");
    });

    it("arrive → 'Arrive at your destination'", async () => {
      const instruction = await getInstruction({
        name: "Zielweg",
        maneuver: { type: "arrive", location: [0, 0] },
      });
      expect(instruction).toBe("Arrive at your destination");
    });

    it("turn + left → 'Turn left onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "Schönhauser Allee",
        maneuver: { type: "turn", modifier: "left", location: [0, 0] },
      });
      expect(instruction).toBe("Turn left onto Schönhauser Allee");
    });

    it("turn without modifier → 'Turn straight onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "Kastanienallee",
        maneuver: { type: "turn", location: [0, 0] },
      });
      expect(instruction).toBe("Turn straight onto Kastanienallee");
    });

    it("merge → 'Merge onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "A100",
        maneuver: { type: "merge", location: [0, 0] },
      });
      expect(instruction).toBe("Merge onto A100");
    });

    it("roundabout with exit → 'At the roundabout, take exit 3 onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "Ernst-Reuter-Platz",
        maneuver: { type: "roundabout", exit: 3, location: [0, 0] },
      });
      expect(instruction).toBe("At the roundabout, take exit 3 onto Ernst-Reuter-Platz");
    });

    it("roundabout without exit → 'At the roundabout, take the exit onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "Kreisverkehr",
        maneuver: { type: "roundabout", location: [0, 0] },
      });
      expect(instruction).toBe("At the roundabout, take the exit onto Kreisverkehr");
    });

    it("on ramp → 'Take the ramp onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "A115",
        maneuver: { type: "on ramp", location: [0, 0] },
      });
      expect(instruction).toBe("Take the ramp onto A115");
    });

    it("off ramp → 'Take exit onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "Ausfahrt Steglitz",
        maneuver: { type: "off ramp", location: [0, 0] },
      });
      expect(instruction).toBe("Take exit onto Ausfahrt Steglitz");
    });

    it("fork → 'Keep [modifier] at the fork onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "B96",
        maneuver: { type: "fork", modifier: "right", location: [0, 0] },
      });
      expect(instruction).toBe("Keep right at the fork onto B96");
    });

    it("fork without modifier → 'Keep straight at the fork onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "B96",
        maneuver: { type: "fork", location: [0, 0] },
      });
      expect(instruction).toBe("Keep straight at the fork onto B96");
    });

    it("end of road → 'At the end of the road, turn [modifier] onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "Dorfstraße",
        maneuver: { type: "end of road", modifier: "left", location: [0, 0] },
      });
      expect(instruction).toBe("At the end of the road, turn left onto Dorfstraße");
    });

    it("end of road without modifier → defaults to 'right'", async () => {
      const instruction = await getInstruction({
        name: "Dorfstraße",
        maneuver: { type: "end of road", location: [0, 0] },
      });
      expect(instruction).toBe("At the end of the road, turn right onto Dorfstraße");
    });

    it("unknown type with name → 'Continue onto [road]'", async () => {
      const instruction = await getInstruction({
        name: "Seitenweg",
        maneuver: { type: "unknown_thing", location: [0, 0] },
      });
      expect(instruction).toBe("Continue onto Seitenweg");
    });

    it("unknown type without name → 'Continue straight'", async () => {
      const instruction = await getInstruction({
        name: "",
        maneuver: { type: "unknown_thing", location: [0, 0] },
      });
      expect(instruction).toBe("Continue straight");
    });

    it("road with ref → 'Main St (A1)'", async () => {
      const instruction = await getInstruction({
        name: "Main St",
        ref: "A1",
        maneuver: { type: "depart", location: [0, 0] },
      });
      expect(instruction).toBe("Head onto Main St (A1)");
    });

    it("road with ref but no name → '(A1)'", async () => {
      const instruction = await getInstruction({
        name: "",
        ref: "A1",
        maneuver: { type: "depart", location: [0, 0] },
      });
      expect(instruction).toBe("Head onto (A1)");
    });

    it("rotary is treated like roundabout", async () => {
      const instruction = await getInstruction({
        name: "Platz der Einheit",
        maneuver: { type: "rotary", exit: 2, location: [0, 0] },
      });
      expect(instruction).toBe("At the roundabout, take exit 2 onto Platz der Einheit");
    });
  });

  describe("optimizeRoute()", () => {
    function makeOsrmTripResponse(overrides: Record<string, unknown> = {}) {
      return {
        code: "Ok",
        trips: [makeOsrmRoute()],
        waypoints: [
          { waypoint_index: 0, trips_index: 0, location: origin },
          { waypoint_index: 2, trips_index: 0, location: [13.395, 52.525] },
          { waypoint_index: 1, trips_index: 0, location: [13.4, 52.53] },
          { waypoint_index: 3, trips_index: 0, location: destination },
        ],
        ...overrides,
      };
    }

    const fourWaypoints: [number, number][] = [
      origin,
      [13.395, 52.525],
      [13.4, 52.53],
      destination,
    ];

    it("calls /trip/v1/driving/ endpoint", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmTripResponse()));

      const { osrmService } = await loadModule();
      await osrmService.optimizeRoute(fourWaypoints);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/trip/v1/driving/");
    });

    it("sets source=first, destination=last, roundtrip=false", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmTripResponse()));

      const { osrmService } = await loadModule();
      await osrmService.optimizeRoute(fourWaypoints);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("source=first");
      expect(url).toContain("destination=last");
      expect(url).toContain("roundtrip=false");
    });

    it("returns optimizedOrder from waypoint indices", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmTripResponse()));

      const { osrmService } = await loadModule();
      const result = await osrmService.optimizeRoute(fourWaypoints);

      expect(result.optimizedOrder).toEqual([0, 2, 1, 3]);
    });

    it("returns routes from trips array", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmTripResponse()));

      const { osrmService } = await loadModule();
      const result = await osrmService.optimizeRoute(fourWaypoints);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].mode).toBe("driving");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(503));

      const { osrmService } = await loadModule();

      await expect(osrmService.optimizeRoute(fourWaypoints)).rejects.toThrow("OSRM trip error 503");
    });

    it("throws when code is not Ok", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ code: "NoTrips", trips: [] }));

      const { osrmService } = await loadModule();

      await expect(osrmService.optimizeRoute(fourWaypoints)).rejects.toThrow(
        "OSRM returned no trips",
      );
    });

    it("passes exclude params from options", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmTripResponse()));

      const { osrmService } = await loadModule();
      await osrmService.optimizeRoute(fourWaypoints, { avoidHighways: true, avoidTolls: true });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("exclude=motorway%2Ctoll");
    });
  });

  describe("request construction", () => {
    it("builds correct URL with coordinates and query params", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      await osrmService.route(waypoints);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/route/v1/driving/13.388,52.517;13.405,52.535");
      expect(url).toContain("overview=full");
      expect(url).toContain("geometries=geojson");
      expect(url).toContain("steps=true");
      expect(url).toContain("alternatives=3");
    });

    it("sends User-Agent header", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      await osrmService.route(waypoints);

      const options = mockFetch.mock.calls[0][1] as RequestInit;
      expect((options.headers as Record<string, string>)["User-Agent"]).toBe("OpenMapX/1.0");
    });

    it("does not include exclude param when no avoid options set", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeOsrmResponse()));

      const { osrmService } = await loadModule();
      await osrmService.route(waypoints);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).not.toContain("exclude");
    });
  });
});
