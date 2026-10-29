import type { AdminServiceData } from "@openmapx/core/api-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@/test";
import { DataInventorySection } from "./DataInventorySection";

afterEach(cleanup);
const osm: AdminServiceData["osm"] = {
  items: [
    {
      artifactId: "a".repeat(64),
      filename: "europe-germany.osm.pbf",
      region: "europe/germany",
      sizeBytes: 1024,
      modifiedAt: "2026-10-29T08:00:00Z",
      sourceFingerprint: "b".repeat(64),
      fingerprintState: "verified",
    },
  ],
  limit: 1,
  offset: 0,
  total: 2,
  unavailable: false,
};
const builds: AdminServiceData["builds"] = [
  {
    target: "osrm",
    built: false,
    readiness: "stale",
    reason: "The source extract changed.",
    sizeBytes: 1024,
    sourceFingerprints: [{ id: "a".repeat(64), sha256: "b".repeat(64) }],
    buildRecordVersion: 2,
    region: "europe/germany",
    runtimeImages: { osrm: "example.test/osrm@sha256:" + "c".repeat(64) },
  },
];
it("shows all source/readiness evidence and pages extracts", () => {
  const page = vi.fn();
  render(<DataInventorySection osm={osm} builds={builds} onPageChange={page} />);
  expect(screen.getByText("europe-germany.osm.pbf")).toBeInTheDocument();
  expect(screen.getByText("The source extract changed.")).toBeInTheDocument();
  expect(screen.getByText(/example.test\/osrm/)).toBeInTheDocument();
  expect(screen.getByText(/Build record v2/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next extracts" }));
  expect(page).toHaveBeenCalledWith(1);
  expect(screen.getByRole("button", { name: "Previous extracts" })).toBeDisabled();
});
it("does not present an unavailable scan as empty or ready", () => {
  render(
    <DataInventorySection
      osm={{ ...osm, items: [], unavailable: true }}
      builds={[]}
      onPageChange={vi.fn()}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(/could not be inspected completely/);
  expect(screen.queryByText("No OSM extracts are available.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Next extracts" })).toBeNull();
});
