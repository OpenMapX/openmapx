import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({
    data: {
      ok: true,
      release: "2026-07-22.0",
      region: "europe/germany",
      placeCount: 1_000,
      linkedCount: 750,
      status: "completed",
      phase: "complete",
      attemptCount: 1,
    },
    isError: false,
    refetch: vi.fn(),
  }),
}));

describe("OvertureMaintenance", () => {
  it("renders release diagnostics and high-level safe operations", async () => {
    const { OvertureMaintenance } = await import("./OvertureMaintenance");
    const markup = renderToStaticMarkup(<OvertureMaintenance apiUrl="http://api.test" />);
    expect(markup).toContain("Overture Places");
    expect(markup).toContain("2026-07-22.0");
    expect(markup).toContain("europe/germany");
    expect(markup).toContain("Full sync");
    expect(markup).toContain("Resume links");
    expect(markup).toContain("completed");
    expect(markup).not.toContain("completed · complete");
  });

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
