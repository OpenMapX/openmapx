import { describe, expect, it } from "vitest";
import { isTransitModeRestriction } from "../contracts/transit-provider";

describe("isTransitModeRestriction", () => {
  it("treats absent, empty and all-transit mode lists as unrestricted", () => {
    expect(isTransitModeRestriction(undefined)).toBe(false);
    expect(isTransitModeRestriction([])).toBe(false);
    expect(isTransitModeRestriction(["TRANSIT"])).toBe(false);
    expect(isTransitModeRestriction(["BUS", "TRANSIT"])).toBe(false);
  });

  it("recognises a subset of transit modes as a restriction", () => {
    expect(isTransitModeRestriction(["BUS"])).toBe(true);
    expect(isTransitModeRestriction(["RAIL", "TRAM"])).toBe(true);
  });
});
