import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({
    data: {
      ok: true,
      region: "europe/germany",
      status: "ready",
      stale: true,
      building: false,
      epoch: "epoch-42",
      placeCount: 12_000,
      termCount: 25_000,
      publishedAt: "2026-08-12T10:00:00.000Z",
    },
    isError: false,
    refetch: vi.fn(),
  }),
}));

describe("SearchIndexMaintenance", () => {
  it("renders published diagnostics and stale rebuild controls", async () => {
    const { SearchIndexMaintenance } = await import("./SearchIndexMaintenance");
    const markup = renderToStaticMarkup(<SearchIndexMaintenance apiUrl="http://api.test" />);
    expect(markup).toContain("OSM code and alias search");
    expect(markup).toContain("europe/germany");
    expect(markup).toContain("12,000");
    expect(markup).toContain("25,000");
    expect(markup).toContain("epoch-42");
    expect(markup).toContain("Rebuild index");
    expect(markup).toContain("newer OSM PBF");
  });

  it("blocks duplicate and regionless builds", async () => {
    const { canBuildSearchIndex, resolveSearchIndexRegion } = await import(
      "./SearchIndexMaintenance"
    );
    expect(canBuildSearchIndex(undefined, "", false)).toBe(false);
    expect(canBuildSearchIndex({ building: true }, "europe/germany", false)).toBe(false);
    expect(canBuildSearchIndex({ building: false }, "europe/germany", false)).toBe(true);
    expect(resolveSearchIndexRegion("", { region: "europe/germany" })).toBe("europe/germany");
    expect(resolveSearchIndexRegion(" europe/france ", { region: "europe/germany" })).toBe(
      "europe/france",
    );
  });
});
