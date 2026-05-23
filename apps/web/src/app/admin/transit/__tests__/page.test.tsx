import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ProviderHealthResponse,
  TransitFeedsResponse,
  TransitJobDetail,
  TransitJobsResponse,
  TransitStateSummary,
} from "@/lib/admin/transitHooks";

// The page renders many MUI table/dialog/select widgets. We only need static
// markup smoke tests — render once with hook responses mocked, then assert
// the section headings + a representative cell appears.

const syncMutate = vi.fn();
const restartMutate = vi.fn();
const resetMutate = vi.fn();

vi.mock("@/lib/EnvProvider", () => ({
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

const sampleState: TransitStateSummary = {
  transitousRef: "abc123def4567890",
  transitousLockedAt: "2026-05-21T12:00:00.000Z",
  transitousLockedBy: "admin@example.com",
  lastSyncAt: "2026-05-22T08:30:00.000Z",
  lastSyncStatus: "success",
  currentJob: null,
  feedCount: 42,
  feeds: {
    byRegion: { "de/db": 10, "ch/sbb": 5, "us/mbta": 2 },
    byStatus: { ok: 12, stale: 3, error: 2 },
  },
};

const sampleFeeds: TransitFeedsResponse = {
  feeds: [
    {
      id: "de/db",
      region: "de/db",
      name: "Deutsche Bahn",
      lastFetchedAt: "2026-05-22T08:00:00.000Z",
      lastImportedAt: "2026-05-22T08:05:00.000Z",
      hash: "sha256:abc",
      validationStatus: "ok",
      validationMessage: null,
      status: "ok",
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

const sampleJobs: TransitJobsResponse = {
  jobs: [
    {
      id: "job-abcdef0123456789",
      kind: "transitous-sync",
      status: "success",
      startedAt: "2026-05-22T08:00:00.000Z",
      finishedAt: "2026-05-22T08:05:00.000Z",
      triggeredBy: "user:admin",
      idempotencyKey: null,
      metadata: null,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

const sampleProviders: ProviderHealthResponse = {
  providers: [
    {
      id: "transitous",
      success: 99,
      failure: 1,
      emaLatencyMs: 120,
      window: [],
      windowFailureRate: 0.01,
    },
  ],
};

vi.mock("@/lib/admin/transitHooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/transitHooks")>(
    "@/lib/admin/transitHooks",
  );
  return {
    ...actual,
    useTransitState: () => ({
      data: sampleState,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: () => {},
    }),
    useTransitFeeds: () => ({ data: sampleFeeds, isLoading: false, isError: false }),
    useTransitJobs: () => ({ data: sampleJobs, isLoading: false, isError: false }),
    useTransitJobDetail: () =>
      ({ data: undefined, isLoading: false, isError: false }) as {
        data: TransitJobDetail | undefined;
        isLoading: boolean;
        isError: boolean;
      },
    useProviderHealth: () => ({ data: sampleProviders, isLoading: false, isError: false }),
    useSyncTransit: () => ({ mutate: syncMutate, isPending: false }),
    useRestartMotis: () => ({ mutate: restartMutate, isPending: false }),
    useResetProvider: () => ({ mutate: resetMutate, isPending: false }),
  };
});

describe("TransitPipelinePage", () => {
  it("renders the major section headings with mocked data", async () => {
    const { TransitPipelinePage } = await import("../TransitPipelinePage");
    const markup = renderToStaticMarkup(<TransitPipelinePage />);
    expect(markup).toContain("Transit pipeline");
    expect(markup).toContain("Transitous lock");
    expect(markup).toContain("Pipeline idle");
    expect(markup).toContain("Feeds breakdown");
    expect(markup).toContain("Recent jobs");
    expect(markup).toContain("Feed state");
    expect(markup).toContain("Provider health");
  });

  it("renders the locked ref + last-sync status from state", async () => {
    const { TransitPipelinePage } = await import("../TransitPipelinePage");
    const markup = renderToStaticMarkup(<TransitPipelinePage />);
    expect(markup).toContain("abc123def4567890");
    expect(markup).toContain("admin@example.com");
    // The success chip's label is what surfaces "last sync status".
    expect(markup).toContain("success");
  });

  it("renders the Run sync now button when no job is in flight", async () => {
    const { TransitPipelinePage } = await import("../TransitPipelinePage");
    const markup = renderToStaticMarkup(<TransitPipelinePage />);
    expect(markup).toContain("Run sync now");
    expect(markup).toContain("Restart MOTIS");
  });

  it("renders feeds-breakdown bars per region", async () => {
    const { TransitPipelinePage } = await import("../TransitPipelinePage");
    const markup = renderToStaticMarkup(<TransitPipelinePage />);
    expect(markup).toContain("de/db");
    expect(markup).toContain("ch/sbb");
  });
});
