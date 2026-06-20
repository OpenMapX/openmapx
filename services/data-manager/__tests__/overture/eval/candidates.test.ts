import { describe, expect, it } from "vitest";
import {
  generateCandidatePairs,
  type OsmPoi,
  type OverturePlace,
} from "../../../src/jobs/overture/eval/candidates.js";

const BERLIN_CENTER: OsmPoi = {
  osmType: "node",
  osmId: "1",
  name: "Café Berlin",
  lat: 52.52,
  lng: 13.405,
  category: "cafes",
};

const OVERTURE_CLOSE: OverturePlace = {
  gersId: "ov-close",
  name: "Cafe Berlin",
  lat: 52.520898,
  lng: 13.405,
};

const OVERTURE_FAR: OverturePlace = {
  gersId: "ov-far",
  name: "Bäckerei Müller",
  lat: 52.5218,
  lng: 13.405,
};

describe("generateCandidatePairs", () => {
  it("excludes overture places beyond 150m radius", () => {
    const pairs = generateCandidatePairs([BERLIN_CENTER], [OVERTURE_FAR]);
    expect(pairs).toHaveLength(0);
  });

  it("includes overture places within 150m radius", () => {
    const pairs = generateCandidatePairs([BERLIN_CENTER], [OVERTURE_CLOSE]);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const pair = pairs[0];
    expect(pair.osmPoi.osmId).toBe("1");
    expect(pair.overturePlace.gersId).toBe("ov-close");
  });

  it("result pairs include distanceM below 150m", () => {
    const pairs = generateCandidatePairs([BERLIN_CENTER], [OVERTURE_CLOSE]);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const pair = pairs[0];
    expect(pair.distanceM).toBeLessThan(150);
    expect(pair.distanceM).toBeGreaterThan(0);
  });

  it("result pairs include nameDice field as a number", () => {
    const pairs = generateCandidatePairs([BERLIN_CENTER], [OVERTURE_CLOSE]);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const pair = pairs[0];
    expect(typeof pair.nameDice).toBe("number");
    expect(pair.nameDice).toBeGreaterThanOrEqual(0);
    expect(pair.nameDice).toBeLessThanOrEqual(1);
  });

  it("skips OSM POIs with empty name", () => {
    const unnamed: OsmPoi = { ...BERLIN_CENTER, osmId: "99", name: "" };
    const pairs = generateCandidatePairs([unnamed], [OVERTURE_CLOSE]);
    expect(pairs).toHaveLength(0);
  });

  it("stratifies candidates across the 4 dice-similarity bands", () => {
    const osmPoi = BERLIN_CENTER;
    const places: OverturePlace[] = [
      { gersId: "high", name: "Café Berlin", lat: 52.520898, lng: 13.405 },
      { gersId: "mid-high", name: "Cafe Berlín", lat: 52.52085, lng: 13.405 },
      { gersId: "mid-low", name: "Restaurant Mitte", lat: 52.5208, lng: 13.405 },
      { gersId: "low", name: "xyz", lat: 52.52075, lng: 13.405 },
    ];
    const pairs = generateCandidatePairs([osmPoi], places, { targetPairs: 8 });
    const gersIds = pairs.map((p) => p.overturePlace.gersId);
    expect(gersIds).toContain("high");
  });

  it("handles empty OSM list", () => {
    const pairs = generateCandidatePairs([], [OVERTURE_CLOSE]);
    expect(pairs).toHaveLength(0);
  });

  it("handles empty Overture list", () => {
    const pairs = generateCandidatePairs([BERLIN_CENTER], []);
    expect(pairs).toHaveLength(0);
  });
});
