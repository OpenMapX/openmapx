import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test";
import { CoveragePage } from "./CoveragePage";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  regions: vi.fn(),
  report: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => "/admin/coverage",
  useSearchParams: () => mocks.params,
}));
vi.mock("@/lib/admin/coverageHooks", () => ({
  useCoverageRegions: mocks.regions,
  useCoverageReport: mocks.report,
}));
vi.mock("./RegionCoverageMatrix", () => ({ RegionCoverageMatrix: () => null }));
vi.mock("./RegionCapabilities", () => ({ RegionCapabilities: () => null }));
vi.mock("./CoverageSourcesTable", () => ({ CoverageSourcesTable: () => null }));
vi.mock("./SourceEvidenceDrawer", () => ({ SourceEvidenceDrawer: () => null }));

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.regions.mockReset().mockReturnValue({
    data: {
      regions: [{ region: { key: "extract:test", label: "Test", kind: "extract" } }],
      warnings: [],
    },
  });
  mocks.report.mockReset().mockReturnValue({});
  mocks.params = new URLSearchParams("regionId=extract:test");
});

describe("CoveragePage snapshot coordination", () => {
  it("waits for the selected region to reach the URL before requesting a report", () => {
    mocks.params = new URLSearchParams();
    render(<CoveragePage />);
    expect(mocks.report).toHaveBeenCalledWith(null);
    expect(mocks.replace).toHaveBeenCalledWith("/admin/coverage?regionId=extract%3Atest&offset=0", {
      scroll: false,
    });
  });

  it("does not re-pin stale cached data while a fresh report is being fetched", () => {
    mocks.report.mockReturnValue({
      isFetching: true,
      data: {
        snapshotId: "expired",
        sources: [],
        warnings: [],
        generatedAt: "2026-09-10T12:00:00Z",
      },
    });
    render(<CoveragePage />);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("resets a rejected revision once even if the same error remains cached", () => {
    mocks.params = new URLSearchParams("regionId=extract:test&snapshotId=expired&offset=50");
    mocks.report.mockReturnValue({
      error: { status: 409, code: "snapshot_expired" },
      isError: true,
    });
    render(<CoveragePage />);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace.mock.calls[0]?.[0]).not.toContain("snapshotId");
  });
});
