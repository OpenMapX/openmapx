import type { CoverageSourceDetail } from "@openmapx/core/coverage";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";
import { SourceEvidenceDrawer } from "./SourceEvidenceDrawer";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const useCoverageSource = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin/coverageHooks", () => ({
  useCoverageSource,
}));

const detail = {
  schemaVersion: 1,
  snapshotId: "snapshot-1",
  generatedAt: "2026-09-10T12:00:00.000Z",
  evaluatedAt: "2026-09-10T12:00:00.000Z",
  collectionStatus: "complete",
  source: {
    key: "poi:owner:source:static",
    sourceId: "source",
    name: "Source name",
    owner: { kind: "integration", id: "owner" },
    domain: "pois",
    stream: "static",
    enabled: true,
    active: true,
    region: { keys: ["extract:first"], basis: "published-region", relation: "exact" },
    presence: "present",
    freshness: "current",
    lastAttemptAt: "2026-09-10T11:59:00.000Z",
    lastSuccessfulCheckAt: "2026-09-10T11:59:00.000Z",
    lastPublishedAt: "2026-09-10T11:59:00.000Z",
    upstreamAsOf: null,
    expiresAt: null,
    latestAttempt: { at: "2026-09-10T11:59:00.000Z", outcome: "succeeded" },
    freshnessDeadline: null,
    rights: { status: "not-applicable", reasons: [], contributorKeys: [], conditions: [] },
    reasons: [],
    correctiveLinks: [],
  },
  evidence: {
    key: "poi:owner:source:static",
    owner: { kind: "integration", id: "owner" },
    sourceId: "source",
    stream: "static",
    domain: "pois",
    observedAt: "2026-09-10T11:59:00.000Z",
    evidenceVersion: 1,
    presence: "present",
    region: { keys: ["extract:first"], basis: "published-region", relation: "exact" },
    publication: { version: "v1", publishedAt: "2026-09-10T11:59:00.000Z", active: true },
    attempt: { at: "2026-09-10T11:59:00.000Z", outcome: "succeeded" },
    lastSuccessfulCheckAt: "2026-09-10T11:59:00.000Z",
    lastSuccessfullyCheckedVersion: "v1",
    upstreamAsOf: null,
    expiresAt: null,
    policy: {
      basis: "fixture",
      staleAt: null,
      expiresAt: null,
      version: "v1",
      provenance: "fixture",
    },
    freshness: "current",
    reasons: [],
  },
  rights: [],
  lineage: [],
  recentAttempts: [],
  warnings: [],
} satisfies CoverageSourceDetail;

describe("SourceEvidenceDrawer", () => {
  it("loads a URL-selected source even when it is not on the current source page", () => {
    useCoverageSource.mockReturnValue({ data: detail, isLoading: false, isError: false });

    render(
      <SourceEvidenceDrawer
        source={null}
        sourceKey="poi:owner:source:static"
        regionId="extract:first"
        snapshotId="snapshot-1"
        assessment="operational"
        onClose={() => undefined}
      />,
    );

    expect(useCoverageSource).toHaveBeenCalledWith({
      key: "poi:owner:source:static",
      regionId: "extract:first",
      snapshotId: "snapshot-1",
      assessment: "operational",
    });
    expect(screen.getByText("Source name")).toBeInTheDocument();
    expect(screen.getAllByText("poi:owner:source:static")).toHaveLength(2);
  });
});

it("shows binding buckets and an actionable missing-graph explanation in the existing drawer", () => {
  useCoverageSource.mockReturnValue({
    data: {
      ...detail,
      evidence: {
        ...detail.evidence,
        roadConditions: {
          status: "validated",
          action: "Import Germany motorway graph",
          changedCount: 0,
          rejectedCount: 2,
          consecutiveFailures: 0,
          bindingCounts: {
            exact: 10,
            likely: 3,
            ambiguous: 2,
            unresolved: 1,
            noCoverage: 4,
            unattempted: 0,
          },
          graph: { status: "missing", generation: null, regions: ["DE"] },
        },
      },
    },
    isLoading: false,
    isError: false,
  });
  render(
    <SourceEvidenceDrawer
      source={null}
      sourceKey="road-feed"
      regionId="extract:first"
      assessment="operational"
      onClose={() => undefined}
    />,
  );
  expect(screen.getByText("Import Germany motorway graph")).toBeInTheDocument();
  expect(screen.getByText("adminCoverage.roadConditions.binding.ambiguous")).toBeInTheDocument();
  expect(screen.getByText("adminCoverage.roadConditions.binding.noCoverage")).toBeInTheDocument();
});
