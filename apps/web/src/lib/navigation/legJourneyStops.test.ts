import { describe, expect, it } from "vitest";
import { sliceJourneyToLeg } from "./legJourneyStops";

const s = (stopId: string) => ({ stopId, name: stopId });

describe("sliceJourneyToLeg", () => {
  it("slices from the board stop to the alight stop inclusive", () => {
    const stops = [s("A"), s("B"), s("C"), s("D")];
    expect(sliceJourneyToLeg(stops, "B", "C").map((x) => x.stopId)).toEqual(["B", "C"]);
  });

  it("matches the alight stop after the board stop on circular routes", () => {
    // A appears twice; boarding at the second A must not match the first as alight.
    const stops = [s("A"), s("B"), s("A"), s("C")];
    expect(sliceJourneyToLeg(stops, "B", "A").map((x) => x.stopId)).toEqual(["B", "A"]);
  });

  it("falls back to the whole list when endpoints are missing", () => {
    const stops = [s("A"), s("B")];
    expect(sliceJourneyToLeg(stops, "X", "Y")).toEqual(stops);
    expect(sliceJourneyToLeg(stops)).toEqual(stops);
  });
});
