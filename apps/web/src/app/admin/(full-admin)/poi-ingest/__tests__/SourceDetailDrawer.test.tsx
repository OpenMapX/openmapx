import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PoiSourceDetail } from "@/lib/admin/poiIngestHooks";

const triggerMutate = vi.fn();

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

vi.mock("@/components/admin/shared/AdminToast", () => ({
  useAdminToast: () => () => {},
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: triggerMutate, isPending: false }),
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

const detail: PoiSourceDetail = {
  source: {
    id: "ev-charging:ocm",
    domain: "ev-charging",
    name: "OpenChargeMap",
    stationIdPrefix: "ocm:",
    coverage: null,
    kinds: {
      static: { cron: "0 3 * * *" },
      live: { cron: "*/5 * * * *" },
    },
  },
  feedState: {
    sourceId: "ev-charging:ocm",
    domain: "ev-charging",
    status: "active",
    consecutiveFailures: 0,
    lastStaticIngestAt: "2026-05-22T08:00:00.000Z",
    lastStaticRowCount: 142_000,
    lastStaticHash: "abcdef0123456789cafebabe",
    lastLiveIngestAt: "2026-05-23T12:00:00.000Z",
    lastLiveRowCount: 12_345,
    lastError: null,
  },
  recentJobs: [
    {
      jobId: "job-abcdef0123456789",
      kind: "static",
      status: "success",
      startedAt: "2026-05-22T08:00:00.000Z",
      finishedAt: "2026-05-22T08:05:00.000Z",
      durationMs: 300_000,
    },
  ],
  inflight: [],
};

vi.mock("@/lib/admin/poiIngestHooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/poiIngestHooks")>(
    "@/lib/admin/poiIngestHooks",
  );
  return {
    ...actual,
    usePoiIngestSourceDetail: () => ({
      data: detail,
      isLoading: false,
      isError: false,
    }),
    useTriggerPoiIngest: () => ({ mutate: triggerMutate, isPending: false }),
  };
});

describe("SourceDetailDrawer", () => {
  it("renders the source header, schedule rows, and action buttons", async () => {
    const { SourceDetailDrawerBody } = await import("../SourceDetailDrawer");
    const markup = renderToStaticMarkup(
      <SourceDetailDrawerBody sourceId="ev-charging:ocm" onClose={() => {}} />,
    );

    expect(markup).toContain("OpenChargeMap");
    expect(markup).toContain("ev-charging:ocm");
    expect(markup).toContain("ev-charging");
    expect(markup).toContain("Global (no coverage bbox)");
    expect(markup).toContain("ocm:");
    expect(markup).toContain("0 3 * * *");
    expect(markup).toContain("*/5 * * * *");
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Sync live only");
    expect(markup).toContain("142,000");
    expect(markup).toContain("abcdef012345");
  });

  it("renders both sync buttons when the source has live + static (not bundled)", async () => {
    const { SourceDetailDrawerBody } = await import("../SourceDetailDrawer");
    const markup = renderToStaticMarkup(
      <SourceDetailDrawerBody sourceId="ev-charging:ocm" onClose={() => {}} />,
    );
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Sync live only");
    // The recent-job duration should be humanised to "Xm".
    expect(markup).toContain("5m");
  });
});
