import type { CoverageRegionsResponse } from "@openmapx/core/coverage";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { RegionCoverageMatrix } from "./RegionCoverageMatrix";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const data: CoverageRegionsResponse = {
  schemaVersion: 1,
  snapshotId: "snapshot-1",
  generatedAt: "2026-09-10T12:00:00.000Z",
  evaluatedAt: "2026-09-10T12:00:00.000Z",
  collectionStatus: "complete",
  collectionAgeSeconds: 0,
  warnings: [],
  authorities: [],
  regions: [
    {
      region: { key: "extract:first", label: "First extract", kind: "extract" },
      domains: {
        addresses: {
          domain: "addresses",
          status: "unknown",
          operational: 0,
          limited: 0,
          unavailable: 0,
          unknown: 2,
          attention: 2,
          reasons: [],
        },
        pois: {
          domain: "pois",
          status: "operational",
          operational: 1,
          limited: 0,
          unavailable: 0,
          unknown: 0,
          attention: 0,
          reasons: [],
        },
        transit: {
          domain: "transit",
          status: "limited",
          operational: 0,
          limited: 1,
          unavailable: 0,
          unknown: 0,
          attention: 1,
          reasons: [],
        },
        ev: {
          domain: "ev",
          status: "unavailable",
          operational: 0,
          limited: 0,
          unavailable: 1,
          unknown: 0,
          attention: 1,
          reasons: [],
        },
        parking: {
          domain: "parking",
          status: "unknown",
          operational: 0,
          limited: 0,
          unavailable: 0,
          unknown: 1,
          attention: 1,
          reasons: [],
        },
        traffic: {
          domain: "traffic",
          status: "operational",
          operational: 1,
          limited: 0,
          unavailable: 0,
          unknown: 0,
          attention: 0,
          reasons: [],
        },
      },
      sourceCount: 4,
      attentionCount: 3,
    },
  ],
  total: 1,
  unassignedSourceCount: 0,
  pagination: { offset: 0, limit: 50, total: 1, hasMore: false, snapshotId: "snapshot-1" },
};

describe("RegionCoverageMatrix", () => {
  it("routes region and domain selections through accessible buttons", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <RegionCoverageMatrix data={data} selectedRegionId="extract:first" onSelect={onSelect} />,
    );

    await user.click(
      screen.getAllByRole("button", { name: "adminCoverage.matrix.selectRegion" })[0],
    );
    expect(onSelect).toHaveBeenCalledWith("extract:first");

    await user.click(
      screen.getAllByRole("button", { name: "adminCoverage.matrix.selectDomain" })[0],
    );
    expect(onSelect).toHaveBeenCalledWith("extract:first", "addresses");
  });
});
