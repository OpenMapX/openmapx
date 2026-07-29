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
  });
});
