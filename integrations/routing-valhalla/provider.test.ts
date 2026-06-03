import { describe, expect, it } from "vitest";
import { transformTraceEdge, valhallaManeuverType } from "./provider.js";

describe("valhallaManeuverType", () => {
  it("maps right-turn enum to normalized turn/right", () => {
    // Valhalla: 10 = turn right
    expect(valhallaManeuverType(10)).toEqual({ type: "turn", modifier: "right" });
  });

  it("maps left-turn enum to normalized turn/left", () => {
    // Valhalla: 14 = turn left
    expect(valhallaManeuverType(14)).toEqual({ type: "turn", modifier: "left" });
  });

  it("maps a depart enum", () => {
    expect(valhallaManeuverType(1)).toEqual({ type: "depart" });
  });

  it("maps destination enum to arrive", () => {
    // Valhalla: 4/5/6 = destination
    expect(valhallaManeuverType(4)).toEqual({ type: "arrive" });
  });

  it("maps a roundabout enum", () => {
    // Valhalla: 26/27 = roundabout enter/exit
    expect(valhallaManeuverType(26).type).toBe("roundabout");
  });

  it("maps a merge enum", () => {
    expect(valhallaManeuverType(21)).toEqual({ type: "merge" });
  });

  it("maps a fork enum with side modifier", () => {
    expect(valhallaManeuverType(18)).toEqual({ type: "fork", modifier: "right" });
    expect(valhallaManeuverType(19)).toEqual({ type: "fork", modifier: "left" });
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
});
