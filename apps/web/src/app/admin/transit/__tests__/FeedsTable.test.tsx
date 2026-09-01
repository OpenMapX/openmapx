import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  TransitFeedsFilters,
  TransitFeedsResponse,
  TransitStateSummary,
} from "@/lib/admin/transitHooks";

const useTransitFeedsMock = vi.fn();

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.mock("@/lib/admin/transitHooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/transitHooks")>(
    "@/lib/admin/transitHooks",
  );
  return {
    ...actual,
    useTransitFeeds: (filters: TransitFeedsFilters) => useTransitFeedsMock(filters),
  };
});

const baseState: TransitStateSummary = {
  transitousRef: null,
  transitousLockedAt: null,
  transitousLockedBy: null,
  lastSyncAt: null,
  lastSyncStatus: null,
  currentJob: null,
  feedCount: 0,
  feeds: {
    byRegion: { "de/db": 3, "ch/sbb": 2 },
    byStatus: { ok: 4, stale: 1 },
  },
};

const sampleFeeds: TransitFeedsResponse = {
  feeds: [
    {
      id: "de/db-ice",
      region: "de/db",
      name: "Deutsche Bahn ICE",
      lastFetchedAt: "2026-05-22T08:00:00.000Z",
      lastImportedAt: null,
      hash: null,
      validationStatus: "warning",
      validationMessage: "Schedule ends in 18 days",
      status: "stale",
    },
    {
      id: "ch/sbb-ic",
      region: "ch/sbb",
      name: "SBB IC",
      lastFetchedAt: null,
      lastImportedAt: null,
      hash: null,
      validationStatus: null,
      validationMessage: null,
      status: "ok",
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

describe("FeedsTable", () => {
  it("calls the hook with default filters and renders one row per feed", async () => {
    const captured: TransitFeedsFilters[] = [];
    useTransitFeedsMock.mockImplementation((filters: unknown) => {
      captured.push(filters as TransitFeedsFilters);
      return { data: sampleFeeds, isLoading: false, isError: false };
    });
    const { FeedsTable } = await import("../FeedsTable");
    const markup = renderToStaticMarkup(<FeedsTable state={baseState} />);

    expect(captured.length > 0).toBe(true);
    expect(captured[0]).toEqual({ region: "", status: "", limit: 50, offset: 0 });

    expect(markup).toContain("Deutsche Bahn ICE");
    expect(markup).toContain("SBB IC");
    expect(markup).toContain("stale");
    expect(markup).toContain("warning");
  });

  it("surfaces the region + status filter dropdowns from the state summary", async () => {
    useTransitFeedsMock.mockReturnValue({ data: sampleFeeds, isLoading: false, isError: false });
    const { FeedsTable } = await import("../FeedsTable");
    const markup = renderToStaticMarkup(<FeedsTable state={baseState} />);

    // MUI's Select uses a portal-backed Menu, so the option items don't show
    // up in static markup. The filter labels themselves, though, do — and the
    // rendered table header reflects the per-row column set.
    expect(markup).toContain("Region");
    expect(markup).toContain("Status");
    expect(markup).toContain("Validation");
    expect(markup).toContain("Last fetched");
  });

  it("shows a friendly empty state when no feeds come back", async () => {
    useTransitFeedsMock.mockReturnValue({
      data: { feeds: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
      isError: false,
    });
    const { FeedsTable } = await import("../FeedsTable");
    const markup = renderToStaticMarkup(<FeedsTable state={baseState} />);
    expect(markup).toContain("No feeds match the current filter.");
  });
});
