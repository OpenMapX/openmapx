import type { RoutingOptions } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCostingOptions,
  buildExclusions,
  buildLocations,
  buildTrafficRequestExtras,
  setValhallaBidirectionalAlternates,
  TRACE_ATTRIBUTE_FILTER,
  transformTraceEdge,
  transformTrip,
  valhallaLanes,
  valhallaManeuverType,
  valhallaService,
  valhallaSign,
} from "./provider.js";

describe("valhallaManeuverType", () => {
  // Every documented Valhalla maneuver.type (0-43) → normalized { type, modifier }.
  // https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/
  const cases: Array<[number, { type: string; modifier?: string }]> = [
    [0, { type: "turn", modifier: "straight" }], // kNone
    [1, { type: "depart" }], // kStart
    [2, { type: "depart" }], // kStartRight
    [3, { type: "depart" }], // kStartLeft
    [4, { type: "arrive" }], // kDestination
    [5, { type: "arrive" }], // kDestinationRight
    [6, { type: "arrive" }], // kDestinationLeft
    [7, { type: "turn", modifier: "straight" }], // kBecomes
    [8, { type: "turn", modifier: "straight" }], // kContinue
    [9, { type: "turn", modifier: "slight right" }], // kSlightRight
    [10, { type: "turn", modifier: "right" }], // kRight
    [11, { type: "turn", modifier: "sharp right" }], // kSharpRight
    [12, { type: "turn", modifier: "uturn" }], // kUturnRight
    [13, { type: "turn", modifier: "uturn" }], // kUturnLeft
    [14, { type: "turn", modifier: "sharp left" }], // kSharpLeft
    [15, { type: "turn", modifier: "left" }], // kLeft
    [16, { type: "turn", modifier: "slight left" }], // kSlightLeft
    [17, { type: "turn", modifier: "straight" }], // kRampStraight
    [18, { type: "fork", modifier: "right" }], // kRampRight
    [19, { type: "fork", modifier: "left" }], // kRampLeft
    [20, { type: "fork", modifier: "right" }], // kExitRight
    [21, { type: "fork", modifier: "left" }], // kExitLeft
    [22, { type: "keep", modifier: "straight" }], // kStayStraight
    [23, { type: "keep", modifier: "right" }], // kStayRight
    [24, { type: "keep", modifier: "left" }], // kStayLeft
    [25, { type: "merge" }], // kMerge
    [26, { type: "roundabout" }], // kRoundaboutEnter
    [27, { type: "roundabout" }], // kRoundaboutExit
    [28, { type: "turn", modifier: "straight" }], // kFerryEnter
    [29, { type: "turn", modifier: "straight" }], // kFerryExit
    [30, { type: "turn", modifier: "straight" }], // kTransit
    [36, { type: "turn", modifier: "straight" }], // kPostTransitConnectionDestination
    [37, { type: "merge" }], // kMergeRight
    [38, { type: "merge" }], // kMergeLeft
    [39, { type: "elevator" }], // kElevatorEnter
    [40, { type: "stairs" }], // kStepsEnter
    [41, { type: "stairs" }], // kEscalatorEnter
    [43, { type: "turn", modifier: "straight" }], // kBuildingExit
  ];

  it.each(cases)("maps Valhalla maneuver.type %i", (input, expected) => {
    expect(valhallaManeuverType(input)).toEqual(expected);
  });

  it("falls back to turn/straight for unknown enums", () => {
    expect(valhallaManeuverType(999)).toEqual({ type: "turn", modifier: "straight" });
  });
});

describe("transformTraceEdge", () => {
  it("maps speed_limit (km/h) to speedLimit and length to metres", () => {
    const edge = transformTraceEdge({
      way_id: 12345,
      length: 0.5, // km
      speed: 48,
      speed_limit: 50,
      surface: "paved_smooth",
      names: ["Friedrichstraße"],
      begin_shape_index: 0,
      end_shape_index: 3,
    });
    expect(edge.speedLimit).toBe(50);
    expect(edge.speed).toBe(48);
    expect(edge.length).toBe(500);
    expect(edge.wayId).toBe(12345);
  });

  it("passes through a missing speed_limit as undefined", () => {
    const edge = transformTraceEdge({ length: 0.1 });
    expect(edge.speedLimit).toBeUndefined();
  });

  it("maps end_node.traffic_signal to endNodeTrafficSignal", () => {
    const signal = transformTraceEdge({ length: 0.1, end_node: { traffic_signal: true } });
    expect(signal.endNodeTrafficSignal).toBe(true);

    const plain = transformTraceEdge({ length: 0.1 });
    expect(plain.endNodeTrafficSignal).toBeUndefined();
  });
});

describe("valhallaLanes", () => {
  it("returns undefined when the maneuver carries no lanes", () => {
    expect(
      valhallaLanes({
        type: 10,
        instruction: "",
        length: 0,
        time: 0,
        begin_shape_index: 0,
        end_shape_index: 0,
      }),
    ).toBeUndefined();
  });

  it("decodes current Valhalla direction and active bitmasks", () => {
    const lanes = valhallaLanes({
      type: 24,
      instruction: "Keep left",
      length: 0,
      time: 0,
      begin_shape_index: 0,
      end_shape_index: 0,
      lanes: [
        { directions: 10, valid: 8, active: 8 }, // through + left; left active
        { directions: 64, valid: 0, active: 0 },
      ],
    });
    expect(lanes).toEqual([
      { indications: ["through", "left"], valid: true, active: "left" },
      { indications: ["right"], valid: false },
    ]);
  });
});

describe("TRACE_ATTRIBUTE_FILTER", () => {
  it("requests the node.traffic_signal attribute", () => {
    expect(TRACE_ATTRIBUTE_FILTER).toContain("node.traffic_signal");
  });
});

describe("valhallaSign", () => {
  it("returns undefined when there is no sign", () => {
    expect(valhallaSign(undefined)).toBeUndefined();
  });

  it("maps exit number / branch / toward / name elements to text arrays", () => {
    expect(
      valhallaSign({
        exit_number_elements: [{ text: "21" }, { text: "21A" }],
        exit_branch_elements: [{ text: "A 57" }],
        exit_toward_elements: [{ text: "Köln" }, { text: "Bonn" }],
        exit_name_elements: [{ text: "Aéroport" }],
      }),
    ).toEqual({
      exitNumbers: ["21", "21A"],
      exitBranches: ["A 57"],
      exitToward: ["Köln", "Bonn"],
      exitNames: ["Aéroport"],
    });
  });

  it("omits empty element groups and returns undefined when all are empty", () => {
    expect(valhallaSign({ exit_number_elements: [] })).toBeUndefined();
    expect(valhallaSign({ exit_toward_elements: [{ text: "Köln" }] })).toEqual({
      exitToward: ["Köln"],
    });
  });
});

describe("buildCostingOptions", () => {
  const defaultSpeedTypes = { speed_types: ["freeflow", "constrained", "predicted"] };

  it("returns only the default speed_types when no avoid flags are set (non-motorised costing)", () => {
    expect(buildCostingOptions({}, "bicycle")).toEqual(defaultSpeedTypes);
  });

  it("sets use_tolls=0 when avoidTolls is set", () => {
    expect(buildCostingOptions({ avoidTolls: true }, "bicycle")).toEqual({
      use_tolls: 0,
      ...defaultSpeedTypes,
    });
  });

  it("maps every avoid flag to its Valhalla costing knob", () => {
    expect(
      buildCostingOptions({ avoidHighways: true, avoidTolls: true, avoidFerries: true }, "bicycle"),
    ).toEqual({ use_highways: 0, use_tolls: 0, use_ferry: 0, ...defaultSpeedTypes });
  });

  it("adds a maneuver penalty for motorised costings only", () => {
    expect(buildCostingOptions({}, "auto")).toEqual({
      maneuver_penalty: 10,
      ...defaultSpeedTypes,
    });
    expect(buildCostingOptions({}, "motorcycle")).toEqual({
      maneuver_penalty: 10,
      ...defaultSpeedTypes,
    });
    expect(buildCostingOptions({}, "pedestrian")).toEqual(defaultSpeedTypes);
  });

  it("adds all speed_types incl current when useLiveTraffic is set", () => {
    expect(
      buildCostingOptions({ useLiveTraffic: true } as RoutingOptions, "auto").speed_types,
    ).toEqual(["freeflow", "constrained", "predicted", "current"]);
  });

  it("omits 'current' when useLiveTraffic is falsy", () => {
    expect(buildCostingOptions({} as RoutingOptions, "auto").speed_types).toEqual([
      "freeflow",
      "constrained",
      "predicted",
    ]);
  });
});

describe("buildExclusions", () => {
  it("returns empty object when no exclusion options are set", () => {
    expect(buildExclusions({})).toEqual({});
  });

  it("omits exclude_locations when the array is empty", () => {
    expect(buildExclusions({ excludeLocations: [] })).toEqual({});
  });

  it("converts excludeLocations tuples to {lon,lat} objects", () => {
    expect(buildExclusions({ excludeLocations: [[5.1, 52.1]] })).toEqual({
      exclude_locations: [{ lon: 5.1, lat: 52.1 }],
    });
  });

  it("converts excludePolygons rings preserving [lon,lat] order", () => {
    const ring: [number, number][] = [
      [5, 52],
      [5.1, 52],
      [5.1, 52.1],
      [5, 52],
    ];
    expect(buildExclusions({ excludePolygons: [ring] })).toEqual({
      exclude_polygons: [ring],
    });
  });

  it("omits exclude_polygons when the array is empty", () => {
    expect(buildExclusions({ excludePolygons: [] })).toEqual({});
  });
});

// Minimal valid Valhalla /route response shape for fetch mocking.
// shape is polyline6 for two [0,0] points: each coord encodes to "?" (value 0 → char 63 = "?").
const MINIMAL_VALHALLA_RESPONSE = {
  trip: {
    summary: { length: 1, time: 60 },
    legs: [
      {
        shape: "????",
        summary: { length: 1, time: 60 },
        maneuvers: [
          {
            type: 1,
            instruction: "Start",
            street_names: ["A 57", "E 31"],
            length: 0.5,
            time: 30,
            begin_shape_index: 0,
            end_shape_index: 1,
          },
          {
            type: 4,
            instruction: "Arrive",
            length: 0.5,
            time: 30,
            begin_shape_index: 1,
            end_shape_index: 1,
          },
        ],
      },
    ],
  },
};

describe("valhallaService.getRoute exclusion body params", () => {
  let capturedBody: Record<string, unknown>;

  beforeEach(() => {
    capturedBody = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return Response.json(MINIMAL_VALHALLA_RESPONSE);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const WPS: [number, number][] = [
    [5.1, 52.1],
    [5.2, 52.2],
  ];

  it("posts exclude_locations when excludeLocations is provided", async () => {
    await valhallaService.getRoute(WPS, "driving", {
      excludeLocations: [[5.1, 52.1]],
    });
    expect(capturedBody.exclude_locations).toEqual([{ lon: 5.1, lat: 52.1 }]);
  });

  it("posts exclude_polygons when excludePolygons is provided", async () => {
    const ring: [number, number][] = [
      [5, 52],
      [5.1, 52],
      [5.1, 52.1],
      [5, 52],
    ];
    await valhallaService.getRoute(WPS, "driving", { excludePolygons: [ring] });
    expect(capturedBody.exclude_polygons).toEqual([ring]);
  });

  it("omits both keys when no exclusion options are passed", async () => {
    await valhallaService.getRoute(WPS, "driving", {});
    expect(capturedBody).not.toHaveProperty("exclude_locations");
    expect(capturedBody).not.toHaveProperty("exclude_polygons");
  });

  it("requests turn-lane data", async () => {
    await valhallaService.getRoute(WPS, "driving", {});
    expect(capturedBody.turn_lanes).toBe(true);
  });

  it("preserves maneuver road names for incident matching", async () => {
    const result = await valhallaService.getRoute(WPS, "driving", {});
    expect(result.routes[0]?.steps[0]?.roadNames).toEqual(["A 57", "E 31"]);
  });

  it("requests turn-lane data for optimized routes", async () => {
    await valhallaService.optimizeRoute(WPS, "driving", {});
    expect(capturedBody.turn_lanes).toBe(true);
  });

  it("forwards sanitized closure exclusions to optimized routes", async () => {
    const ring: [number, number][] = [
      [5, 52],
      [5.1, 52],
      [5.1, 52.1],
      [5, 52],
    ];
    await valhallaService.optimizeRoute(WPS, "driving", {
      excludeLocations: [[5.1, 52.1]],
      excludePolygons: [ring],
    });
    expect(capturedBody.exclude_locations).toEqual([{ lon: 5.1, lat: 52.1 }]);
    expect(capturedBody.exclude_polygons).toEqual([ring]);
  });
});

describe("transformTrip baseline duration", () => {
  const trip = (summary: Partial<Parameters<typeof transformTrip>[0]["summary"]> = {}) => ({
    summary: { length: 10, time: 600, ...summary },
    legs: [
      {
        shape: "_p~iF~ps|U",
        summary: { length: 10, time: 600 },
        maneuvers: [
          {
            type: 1,
            instruction: "Drive north.",
            length: 10,
            time: 600,
            begin_shape_index: 0,
            end_shape_index: 1,
          },
        ],
      },
    ],
  });

  it("maps time_baseline onto baselineDuration", () => {
    const route = transformTrip(trip({ time_baseline: 520 }), "driving");
    expect(route.baselineDuration).toBe(520);
    expect(route.duration).toBe(600);
  });

  it("treats a null time_baseline as absent", () => {
    const route = transformTrip(trip({ time_baseline: null }), "driving");
    expect(route.baselineDuration).toBeUndefined();
  });

  it("omits baselineDuration when the engine sent no recosting", () => {
    const route = transformTrip(trip(), "driving");
    expect(route.baselineDuration).toBeUndefined();
  });

  it("ignores non-finite or negative baseline values", () => {
    expect(
      transformTrip(trip({ time_baseline: Number.NaN }), "driving").baselineDuration,
    ).toBeUndefined();
    expect(transformTrip(trip({ time_baseline: -1 }), "driving").baselineDuration).toBeUndefined();
  });
});

describe("buildTrafficRequestExtras", () => {
  const live = { useLiveTraffic: true } as RoutingOptions;
  const costingOptions = { maneuver_penalty: 10 };

  it("sends nothing at all when the feature flag is off", () => {
    expect(buildTrafficRequestExtras(live, "auto", costingOptions, 2, false)).toEqual({});
  });

  it("sends nothing for a non-live-traffic mode", () => {
    expect(
      buildTrafficRequestExtras({} as RoutingOptions, "pedestrian", costingOptions, 2, true),
    ).toEqual({});
  });

  it("sends all three fields for a depart-now two-waypoint motorised request", () => {
    const extras = buildTrafficRequestExtras(live, "auto", costingOptions, 2, true);
    expect(extras.prioritize_bidirectional).toBe(true);
    expect(extras.reverse_time_tracking).toBe("heuristic");
    expect(extras.recostings).toBeDefined();
  });

  it("omits the bidirectional fields when departAt pins the departure", () => {
    const extras = buildTrafficRequestExtras(
      { ...live, departAt: "2026-08-01T09:00" } as RoutingOptions,
      "auto",
      costingOptions,
      2,
      true,
    );
    expect(extras.prioritize_bidirectional).toBeUndefined();
    expect(extras.reverse_time_tracking).toBeUndefined();
    expect(extras.recostings).toBeDefined();
  });

  it("omits the bidirectional fields for arriveBy", () => {
    const extras = buildTrafficRequestExtras(
      { ...live, arriveBy: "2026-08-01T09:00" } as RoutingOptions,
      "auto",
      costingOptions,
      2,
      true,
    );
    expect(extras.prioritize_bidirectional).toBeUndefined();
  });

  it("omits the bidirectional fields when there are more than two waypoints", () => {
    const extras = buildTrafficRequestExtras(live, "auto", costingOptions, 3, true);
    expect(extras.prioritize_bidirectional).toBeUndefined();
    expect(extras.recostings).toBeDefined();
  });

  it("recosts against everything except live speeds, preserving other options", () => {
    const extras = buildTrafficRequestExtras(
      live,
      "auto",
      { maneuver_penalty: 10, use_tolls: 0 },
      2,
      true,
    );
    expect(extras.recostings).toEqual([
      {
        costing: "auto",
        name: "baseline",
        costing_options: {
          auto: {
            maneuver_penalty: 10,
            use_tolls: 0,
            speed_types: ["freeflow", "constrained", "predicted"],
          },
        },
      },
    ]);
  });
});

describe("getRoute request body", () => {
  const okResponse = {
    trip: {
      summary: { length: 1, time: 60 },
      legs: [
        {
          shape: "_p~iF~ps|U",
          summary: { length: 1, time: 60 },
          maneuvers: [
            {
              type: 1,
              instruction: "Drive north.",
              length: 1,
              time: 60,
              begin_shape_index: 0,
              end_shape_index: 1,
            },
          ],
        },
      ],
    },
  };

  const capture = () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify(okResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  const bodyOf = (spy: ReturnType<typeof capture>) =>
    JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);

  afterEach(() => {
    vi.unstubAllGlobals();
    setValhallaBidirectionalAlternates(true);
  });

  it("includes the traffic extras for a depart-now driving route", async () => {
    const spy = capture();
    await valhallaService.getRoute(
      [
        [6.08, 50.77],
        [6.68, 51.51],
      ],
      "driving",
      { useLiveTraffic: true },
    );
    const body = bodyOf(spy);
    expect(body.prioritize_bidirectional).toBe(true);
    expect(body.reverse_time_tracking).toBe("heuristic");
    expect(body.recostings).toHaveLength(1);
    // The running Valhalla service caps this at two alternates, i.e. three
    // routes including the primary. Request the service-limit-aligned value
    // rather than relying on server-side clamping.
    expect(body.alternates).toBe(2);
  });

  it("preserves Valhalla's diagnostic response body on an upstream error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response('{"error":"Exceeded max avoid locations: 50"}', { status: 400 }),
      ),
    );

    await expect(
      valhallaService.getRoute(
        [
          [6.08, 50.77],
          [6.68, 51.51],
        ],
        "driving",
        {},
      ),
    ).rejects.toThrow('Valhalla error 400: {"error":"Exceeded max avoid locations: 50"}');
  });

  it("sends a body without any of the new keys when the flag is off", async () => {
    setValhallaBidirectionalAlternates(false);
    const spy = capture();
    await valhallaService.getRoute(
      [
        [6.08, 50.77],
        [6.68, 51.51],
      ],
      "driving",
      { useLiveTraffic: true },
    );
    const body = bodyOf(spy);
    expect(body).not.toHaveProperty("prioritize_bidirectional");
    expect(body).not.toHaveProperty("reverse_time_tracking");
    expect(body).not.toHaveProperty("recostings");
  });

  it("does not add the new keys for walking", async () => {
    const spy = capture();
    await valhallaService.getRoute(
      [
        [6.08, 50.77],
        [6.09, 50.78],
      ],
      "walking",
      {},
    );
    const body = bodyOf(spy);
    expect(body).not.toHaveProperty("prioritize_bidirectional");
    expect(body).not.toHaveProperty("recostings");
  });
});

describe("buildLocations", () => {
  const dwellWaypoints: [number, number][] = [
    [6.96, 50.94],
    [7.1, 51.0],
    [7.2, 51.1],
  ];

  it("marks every waypoint as a break and omits waiting when no dwell is set", () => {
    expect(buildLocations(dwellWaypoints, {})).toEqual([
      { lon: 6.96, lat: 50.94, type: "break" },
      { lon: 7.1, lat: 51.0, type: "break" },
      { lon: 7.2, lat: 51.1, type: "break" },
    ]);
  });

  it("sets waiting on intermediate waypoints only", () => {
    const locations = buildLocations(dwellWaypoints, { dwellSeconds: [300, 900, 600] });
    expect(locations[0]).not.toHaveProperty("waiting");
    expect(locations[1]).toMatchObject({ waiting: 900 });
    expect(locations[2]).not.toHaveProperty("waiting");
  });

  it("omits waiting for a zero or missing dwell", () => {
    const locations = buildLocations(dwellWaypoints, { dwellSeconds: [undefined, 0, undefined] });
    expect(locations[1]).not.toHaveProperty("waiting");
  });
});

describe("valhallaService.temporal", () => {
  it("declares dwell as native and the waypoint windows as emulated", () => {
    expect(valhallaService.temporal).toEqual({
      tripDepartAt: "native",
      tripArriveBy: "native",
      dwell: "native",
      waypointDepartAfter: "emulated",
      waypointArriveBy: "emulated",
      timeDependentTravel: "native",
    });
  });
});
