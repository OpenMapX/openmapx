import { uniqueModes } from "@integrations/transit-motis/mode-map";
import { motisMode } from "@openmapx/mobility-core/motis-radar";
import { describe, expect, it } from "vitest";

describe("motisMode", () => {
  it("maps WALK to walking", () => {
    expect(motisMode("WALK")).toBe("walking");
  });
  it("maps TRAM to tram", () => {
    expect(motisMode("TRAM")).toBe("tram");
  });
  it("maps SUBWAY to subway", () => {
    expect(motisMode("SUBWAY")).toBe("subway");
  });
  it("maps rail variants to rail", () => {
    for (const m of [
      "RAIL",
      "HIGHSPEED_RAIL",
      "LONG_DISTANCE",
      "NIGHT_RAIL",
      "REGIONAL_FAST_RAIL",
      "REGIONAL_RAIL",
      "SUBURBAN",
    ]) {
      expect(motisMode(m as never)).toBe("rail");
    }
  });
  it("maps FERRY to ferry", () => {
    expect(motisMode("FERRY")).toBe("ferry");
  });
  it("maps AERIAL_LIFT to gondola", () => {
    expect(motisMode("AERIAL_LIFT")).toBe("gondola");
  });
  it("maps FUNICULAR to funicular", () => {
    expect(motisMode("FUNICULAR")).toBe("funicular");
  });
  it("maps MONORAIL to monorail", () => {
    expect(motisMode("MONORAIL")).toBe("monorail");
  });
  it("maps BUS and COACH to bus", () => {
    expect(motisMode("BUS")).toBe("bus");
    expect(motisMode("COACH")).toBe("bus");
  });
  it("falls back to bus for unknown modes", () => {
    expect(motisMode("OTHER")).toBe("bus");
    expect(motisMode(undefined)).toBe("bus");
  });
});

describe("uniqueModes", () => {
  it("deduplicates mapped modes", () => {
    const result = uniqueModes(["RAIL", "HIGHSPEED_RAIL", "BUS", "BUS"]);
    expect(result).toEqual(["rail", "bus"]);
  });
  it("returns empty array for empty input", () => {
    expect(uniqueModes([])).toEqual([]);
  });
});
