import { describe, expect, it } from "vitest";
import {
  buildCostingOptions,
  TRACE_ATTRIBUTE_FILTER,
  transformTraceEdge,
  valhallaLanes,
  valhallaManeuverType,
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
    [22, { type: "turn", modifier: "straight" }], // kStayStraight
    [23, { type: "fork", modifier: "right" }], // kStayRight
    [24, { type: "fork", modifier: "left" }], // kStayLeft
    [25, { type: "merge" }], // kMerge
    [26, { type: "roundabout" }], // kRoundaboutEnter
    [27, { type: "roundabout" }], // kRoundaboutExit
    [28, { type: "turn", modifier: "straight" }], // kFerryEnter
    [29, { type: "turn", modifier: "straight" }], // kFerryExit
    [30, { type: "turn", modifier: "straight" }], // kTransit
    [36, { type: "turn", modifier: "straight" }], // kPostTransitConnectionDestination
    [37, { type: "merge" }], // kMergeRight
    [38, { type: "merge" }], // kMergeLeft
    [39, { type: "turn", modifier: "straight" }], // kElevatorEnter
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

  it("maps directions to indications and derives validity (boolean form)", () => {
    const lanes = valhallaLanes({
      type: 10,
      instruction: "",
      length: 0,
      time: 0,
      begin_shape_index: 0,
      end_shape_index: 0,
      lanes: [
        { directions: ["left"], valid: false, active: false },
        { directions: ["through", "right"], valid: true, active: false },
      ],
    });
    expect(lanes).toEqual([
      { indications: ["left"], valid: false },
      { indications: ["through", "right"], valid: true },
    ]);
  });

  it("captures the active indication from array-form active/valid lanes", () => {
    const lanes = valhallaLanes({
      type: 10,
      instruction: "",
      length: 0,
      time: 0,
      begin_shape_index: 0,
      end_shape_index: 0,
      lanes: [
        { directions: ["through", "right"], valid: ["right"], active: ["right"] },
        { directions: ["left"], valid: [], active: [] },
      ],
    });
    expect(lanes?.[0]).toEqual({ indications: ["through", "right"], valid: true, active: "right" });
    expect(lanes?.[1]).toEqual({ indications: ["left"], valid: false });
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
  it("returns an empty object when no avoid flags are set", () => {
    expect(buildCostingOptions({})).toEqual({});
  });

  it("sets use_tolls=0 when avoidTolls is set", () => {
    expect(buildCostingOptions({ avoidTolls: true })).toEqual({ use_tolls: 0 });
  });

  it("maps every avoid flag to its Valhalla costing knob", () => {
    expect(
      buildCostingOptions({ avoidHighways: true, avoidTolls: true, avoidFerries: true }),
    ).toEqual({ use_highways: 0, use_tolls: 0, use_ferry: 0 });
  });
});
