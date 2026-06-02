import { describe, expect, it } from "vitest";
import { valhallaManeuverType } from "./provider.js";

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
