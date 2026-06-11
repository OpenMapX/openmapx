import { describe, expect, it } from "vitest";
import { motisLegMode, motisMode, uniqueModes } from "../mode-map.js";

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
