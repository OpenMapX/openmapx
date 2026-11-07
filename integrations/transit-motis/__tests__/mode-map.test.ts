import { motisMode } from "@openmapx/mobility-core/motis-radar";
import { describe, expect, it } from "vitest";
import { motisLegMode, uniqueModes } from "../mode-map.js";

describe("motisMode — intermodal access legs render distinctly from walking", () => {
  it("maps bike access modes to cycling", () => {
    expect(motisMode("BIKE")).toBe("cycling");
    expect(motisMode("RENTAL")).toBe("cycling");
  });

  it("maps car access modes to driving", () => {
    expect(motisMode("CAR")).toBe("driving");
    expect(motisMode("CAR_PARKING")).toBe("driving");
    expect(motisMode("CAR_DROPOFF")).toBe("driving");
  });

  it("keeps walking distinct from the bike/car access modes", () => {
    expect(motisMode("WALK")).toBe("walking");
    expect(motisMode("WALK")).not.toBe(motisMode("BIKE"));
    expect(motisMode("WALK")).not.toBe(motisMode("CAR"));
  });

  it("defaults unknown / undefined modes to bus", () => {
    expect(motisMode(undefined)).toBe("bus");
    expect(motisMode("NONSENSE")).toBe("bus");
  });
});

describe("motisLegMode — refines RENTAL by GBFS form factor", () => {
  it("treats car-like rentals (CAR/MOPED) as driving", () => {
    expect(motisLegMode({ mode: "RENTAL", rental: { formFactor: "CAR" } })).toBe("driving");
    expect(motisLegMode({ mode: "RENTAL", rental: { formFactor: "MOPED" } })).toBe("driving");
  });

  it("treats bike-share rentals as cycling", () => {
    expect(motisLegMode({ mode: "RENTAL", rental: { formFactor: "BICYCLE" } })).toBe("cycling");
    expect(motisLegMode({ mode: "RENTAL", rental: null })).toBe("cycling");
  });

  it("falls back to the static table for non-rental legs", () => {
    expect(motisLegMode({ mode: "SUBWAY" })).toBe("subway");
    expect(motisLegMode({ mode: "WALK" })).toBe("walking");
  });
});

describe("uniqueModes", () => {
  it("deduplicates mapped transport modes", () => {
    expect(uniqueModes(["BIKE", "RENTAL", "WALK"])).toEqual(["cycling", "walking"]);
  });
});

describe("MOTIS public-transport mode mapping", () => {
  it.each([
    ["TRAM", "tram"],
    ["SUBWAY", "subway"],
    ["RAIL", "rail"],
    ["HIGHSPEED_RAIL", "rail"],
    ["LONG_DISTANCE", "rail"],
    ["NIGHT_RAIL", "rail"],
    ["REGIONAL_FAST_RAIL", "rail"],
    ["REGIONAL_RAIL", "rail"],
    ["SUBURBAN", "rail"],
    ["FERRY", "ferry"],
    ["AERIAL_LIFT", "gondola"],
    ["FUNICULAR", "funicular"],
    ["MONORAIL", "monorail"],
    ["BUS", "bus"],
    ["COACH", "bus"],
    ["OTHER", "bus"],
  ])("maps %s to %s", (input, expected) => {
    expect(motisMode(input)).toBe(expected);
  });
});

it("deduplicates equivalent rail modes and repeated bus modes in input order", () => {
  expect(uniqueModes(["RAIL", "HIGHSPEED_RAIL", "BUS", "BUS"])).toEqual(["rail", "bus"]);
});
it("returns no modes for empty input", () => {
  expect(uniqueModes([])).toEqual([]);
});
