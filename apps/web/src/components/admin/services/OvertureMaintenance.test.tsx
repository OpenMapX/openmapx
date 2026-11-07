import { describe, expect, it } from "vitest";

describe("OvertureMaintenance", () => {
  it("uses phase-specific progress denominators", async () => {
    const { overtureProgress } = await import("./OvertureMaintenance");
    expect(
      overtureProgress({
        status: "running",
        phase: "score",
        placeCount: 4_000_000,
        extractedCount: 1_400_000,
        processedCount: 700_000,
      }),
    ).toEqual({ value: 50, label: "700,000 of 1,400,000 OSM POIs scored" });
    expect(
      overtureProgress({
        status: "running",
        phase: "assign",
        componentCount: 200,
        assignmentCursor: 50,
      }),
    ).toEqual({ value: 25, label: "50 of 200 components assigned" });
    expect(overtureProgress({ status: "running", phase: "publish" })).toEqual({
      value: null,
      label: "Validating and publishing links",
    });
  });

  it("allows only an expired running lease to be resumed", async () => {
    const { canResumeOvertureLinks } = await import("./OvertureMaintenance");
    expect(
      canResumeOvertureLinks({ status: "running", stalled: false }, "europe/germany", false),
    ).toBe(false);
    expect(
      canResumeOvertureLinks({ status: "running", stalled: true }, "europe/germany", false),
    ).toBe(true);
  });
});
