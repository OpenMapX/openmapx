import { describe, expect, it } from "vitest";
import { transitPlanningMetadata } from "./useTransitPlanRequest";

const metadata = (datasetEpoch: string) => ({
  source: "acme",
  instance: "main",
  datasetEpoch,
  rentalFormFactors: [],
});

describe("transit planning metadata", () => {
  it("reads planning metadata from whichever planner provides it", () => {
    expect(
      transitPlanningMetadata({ providers: [{ id: "transit-acme", metadata: metadata("e1") }] })
        ?.datasetEpoch,
    ).toBe("e1");
  });

  it("takes the first planner in order that carries metadata", () => {
    expect(
      transitPlanningMetadata({
        providers: [
          { id: "transit-plain" },
          { id: "transit-first", metadata: metadata("first") },
          { id: "transit-second", metadata: metadata("second") },
        ],
      })?.datasetEpoch,
    ).toBe("first");
  });

  it("has none before the capabilities arrive or when no planner reports any", () => {
    expect(transitPlanningMetadata(undefined)).toBeUndefined();
    expect(transitPlanningMetadata({ providers: [{ id: "transit-plain" }] })).toBeUndefined();
  });
});
