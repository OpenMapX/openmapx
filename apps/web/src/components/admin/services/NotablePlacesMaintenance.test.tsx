import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({ data: status.current, isError: false, refetch: vi.fn() }),
}));

describe("NotablePlacesMaintenance", () => {
  it("shows the published snapshot and offers a rebuild", async () => {
    status.current = {
      ok: true,
      status: "ready",
      building: false,
      placeCount: 147_591,
      nameCount: 787_631,
      minSitelinks: 8,
      publishedAt: "2026-10-01T10:00:00.000Z",
    };
    const { NotablePlacesMaintenance } = await import("./NotablePlacesMaintenance");
    const markup = renderToStaticMarkup(<NotablePlacesMaintenance apiUrl="http://api.test" />);
    expect(markup).toContain("Notable places");
    expect(markup).toContain("147,591");
    expect(markup).toContain("787,631");
    expect(markup).toContain("Rebuild now");
  });

  it("explains what search does without an index", async () => {
    status.current = { ok: false, error: "notable_places index not built" };
    const { NotablePlacesMaintenance } = await import("./NotablePlacesMaintenance");
    const markup = renderToStaticMarkup(<NotablePlacesMaintenance apiUrl="http://api.test" />);
    expect(markup).toContain("No notable-places index is published yet");
    expect(markup).toContain("Build now");
  });
});
