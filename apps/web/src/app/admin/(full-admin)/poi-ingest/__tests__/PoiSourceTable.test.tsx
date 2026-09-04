import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  PoiIngestStateSummary,
  PoiSourceSummary,
  PoiSourcesFilters,
} from "@/lib/admin/poiIngestHooks";

const usePoiIngestSourcesMock = vi.fn();
const triggerMutate = vi.fn();

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

vi.mock("@/components/admin/shared/AdminToast", () => ({
  useAdminToast: () => () => {},
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.mock("@/lib/admin/poiIngestHooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/poiIngestHooks")>(
    "@/lib/admin/poiIngestHooks",
  );
  return {
    ...actual,
    usePoiIngestSources: (filters: PoiSourcesFilters) => usePoiIngestSourcesMock(filters),
    useTriggerPoiIngest: () => ({ mutate: triggerMutate, isPending: false }),
  };
});

const baseState: PoiIngestStateSummary = {
  sourcesCount: 2,
  byDomain: { "ev-charging": 1, parking: 1 },
  byStatus: { active: 1, stale: 0, failed: 1, unknown: 0 },
  recentFailures: [],
  inflight: [],
  registryCountMatchesUpstream: true,
};

const sampleSources: PoiSourceSummary[] = [
  {
    sourceId: "ev-charging:ocm",
    domain: "ev-charging",
    name: "OpenChargeMap",
    kinds: ["static", "live"],
    status: "active",
    consecutiveFailures: 0,
    lastStaticIngestAt: "2026-05-22T08:00:00.000Z",
    lastLiveIngestAt: "2026-05-23T12:00:00.000Z",
    lastStaticRowCount: 142_000,
    lastLiveRowCount: 12_345,
  },
  {
    sourceId: "parking:bnetza",
    domain: "parking",
    name: "Bundesnetzagentur parking",
    kinds: ["bundled"],
    status: "failed",
    consecutiveFailures: 3,
    lastStaticIngestAt: null,
    lastLiveIngestAt: null,
    lastStaticRowCount: null,
    lastLiveRowCount: null,
  },
];

describe("PoiSourceTable", () => {
  it("renders one row per source and reflects the status chip", async () => {
    const captured: PoiSourcesFilters[] = [];
    usePoiIngestSourcesMock.mockImplementation((filters: unknown) => {
      captured.push(filters as PoiSourcesFilters);
      return { data: sampleSources, isLoading: false, isError: false };
    });
    const { PoiSourceTable } = await import("../PoiSourceTable");
    const markup = renderToStaticMarkup(<PoiSourceTable state={baseState} onSelect={() => {}} />);

    expect(captured.length > 0).toBe(true);
    expect(captured[0]).toEqual({ domain: "", status: "" });

    expect(markup).toContain("ev-charging:ocm");
    expect(markup).toContain("OpenChargeMap");
    expect(markup).toContain("parking:bnetza");
    expect(markup).toContain("active");
    expect(markup).toContain("failed");
    expect(markup).toContain("bundled");
    expect(markup).toContain("142,000");
  });

  it("renders the domain + status filter dropdowns from the state summary", async () => {
    usePoiIngestSourcesMock.mockReturnValue({
      data: sampleSources,
      isLoading: false,
      isError: false,
    });
    const { PoiSourceTable } = await import("../PoiSourceTable");
    const markup = renderToStaticMarkup(<PoiSourceTable state={baseState} onSelect={() => {}} />);

    expect(markup).toContain("Domain");
    expect(markup).toContain("Status");
    expect(markup).toContain("Sources (2)");
  });

  it("shows a friendly empty state when no sources come back", async () => {
    usePoiIngestSourcesMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
    const { PoiSourceTable } = await import("../PoiSourceTable");
    const markup = renderToStaticMarkup(<PoiSourceTable state={baseState} onSelect={() => {}} />);
    expect(markup).toContain("No sources match the current filter.");
  });

  it("renders em-dash placeholders for null row counts and timestamps", async () => {
    usePoiIngestSourcesMock.mockReturnValue({
      data: [sampleSources[1]],
      isLoading: false,
      isError: false,
    });
    const { PoiSourceTable } = await import("../PoiSourceTable");
    const markup = renderToStaticMarkup(<PoiSourceTable state={baseState} onSelect={() => {}} />);
    expect(markup).toContain("—");
  });
});
