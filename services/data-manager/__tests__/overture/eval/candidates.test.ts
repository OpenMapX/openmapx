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

  it("includes nearby places with their identities, distance, and bounded similarity", () => {
    const pairs = generateCandidatePairs([BERLIN_CENTER], [OVERTURE_CLOSE]);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0];
    expect(pair.osmPoi.osmId).toBe("1");
    expect(pair.overturePlace.gersId).toBe("ov-close");
    expect(pair.distanceM).toBeLessThan(150);
    expect(pair.distanceM).toBeGreaterThan(0);
    expect(typeof pair.nameDice).toBe("number");
    expect(pair.nameDice).toBeGreaterThanOrEqual(0);
    expect(pair.nameDice).toBeLessThanOrEqual(1);
  });

  it("skips OSM POIs with empty name", () => {
    const unnamed: OsmPoi = { ...BERLIN_CENTER, osmId: "99", name: "" };
    const pairs = generateCandidatePairs([unnamed], [OVERTURE_CLOSE]);
    expect(pairs).toHaveLength(0);
  });

  it("samples each of the four similarity bands before taking another from one band", () => {
    const osmPoi = { ...BERLIN_CENTER, name: "abcdefghij" };
    // These names share 9, 7, 4, and 0 of the source's 9 bigrams: the
    // independently known Dice scores are 1, 7/9, 4/9, and 0.
    // High bands deliberately precede low bands so a global slice cannot pass.
    const places: OverturePlace[] = [
      ["high", "abcdefghij"],
      ["mid-high", "abcdefghzz"],
      ["mid-low", "abcdezzzzz"],
      ["low", "zzzzzzzzzz"],
    ].flatMap(([band, name]) =>
      [1, 2].map((ordinal) => ({
        gersId: `${band}-${ordinal}`,
        name,
        lat: 52.520898,
        lng: 13.405,
      })),
    );
    const pairs = generateCandidatePairs([osmPoi], places, { targetPairs: 4 });
    expect(pairs.map((pair) => pair.overturePlace.gersId)).toEqual([
      "low-1",
      "mid-low-1",
      "mid-high-1",
      "high-1",
    ]);
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
