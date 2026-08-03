import type { Route } from "@openmapx/core";
import { createNavigationSessionSnapshot, type OfflineMapPackageManifest } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { createOfflinePackageResolver } from "../offlineAreas/packageResolver";
import { MemoryOfflinePackageStorage } from "../offlineAreas/packageStorage";
import type { OfflinePackageRecord } from "../offlineAreas/types";
import { getOfflineRouteCoverage } from "./offlineRouteCoverage";

const idA = `omp1-${"a".repeat(64)}`;
const idB = `omp1-${"b".repeat(64)}`;
const route: Route = {
  distance: 100,
  duration: 60,
  geometry: [
    [0.2, 0.2],
    [0.8, 0.8],
  ],
  legs: [
    {
      distance: 100,
      duration: 60,
      geometry: [
        [0.2, 0.2],
        [0.8, 0.8],
      ],
      steps: [
        {
          instruction: "Continue",
          distance: 100,
          duration: 60,
          coordinates: [
            [0.2, 0.2],
            [0.8, 0.8],
          ],
        },
      ],
    },
  ],
  steps: [
    {
      instruction: "Continue",
      distance: 100,
      duration: 60,
      coordinates: [
        [0.2, 0.2],
        [0.8, 0.8],
      ],
    },
  ],
  mode: "driving",
};

function manifest(
  packageId: string,
  bbox = { west: 0, south: 0, east: 1, north: 1 },
): OfflineMapPackageManifest {
  return {
    schemaVersion: 1,
    packageId,
    requestKey: packageId,
    dataset: {
      id: "openmapx",
      version: "dataset-v1",
      generatedAt: "2026-08-03T00:00:00.000Z",
      sourceMaxZoom: 14,
      tileSchema: "openmaptiles",
    },
    coverage: { bbox, minZoom: 0, maxZoom: 14 },
    archive: {
      url: `/api/offline/packages/${packageId}/archive`,
      contentType: "application/vnd.pmtiles",
      byteLength: 1,
      sha256: "a".repeat(64),
      etag: `sha256-${"a".repeat(64)}`,
    },
    style: {
      provider: "openmapx",
      version: "style-v1",
      variants: ["light", "dark"],
      assetBaseUrl: "/api/offline/packages/assets/openmapx/style-v1",
    },
    attribution: ["© OpenStreetMap contributors"],
  };
}

function record(id: string, m: OfflineMapPackageManifest): OfflinePackageRecord {
  return {
    id,
    name: id,
    manifest: m,
    status: "ready",
    bytesReceived: 1,
    bytesTotal: 1,
    verifiedPrefixBytes: 1,
    createdAt: 1,
    updatedAt: 1,
    downloadedAt: 1,
  };
}

function snapshot(packageIds: string[]) {
  return createNavigationSessionSnapshot({
    route,
    routes: [route],
    activeRouteIndex: 0,
    routeSelectionIntent: "automatic",
    mode: "driving",
    routeOptions: {
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
      avoidClosures: false,
    },
    routeProvider: "osrm",
    destinationWaypoints: [
      [0.2, 0.2],
      [0.8, 0.8],
    ],
    progress: null,
    packageIds,
    startedAtMs: 1,
    updatedAtMs: 2,
  });
}

async function resolverWith(records: OfflinePackageRecord[]) {
  const storage = new MemoryOfflinePackageStorage();
  for (const item of records) await storage.put(item);
  const resolver = createOfflinePackageResolver(storage, {
    datasetVersion: "dataset-v1",
    styleVersion: "style-v1",
    tileSchema: "openmaptiles",
  });
  await resolver.refresh();
  return resolver;
}

describe("offline route coverage", () => {
  it("reports covered for a compatible ready package", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    expect(getOfflineRouteCoverage(snapshot([idA]), resolver, [0.2, 0.2])).toEqual({
      kind: "covered",
      packageId: idA,
    });
  });

  it("reports route-line-only when a saved route has no map coverage", async () => {
    const resolver = await resolverWith([
      record(idA, manifest(idA, { west: 2, south: 2, east: 3, north: 3 })),
    ]);
    expect(getOfflineRouteCoverage(snapshot([idA]), resolver, [0.2, 0.2])).toEqual({
      kind: "route-line-only",
      packageIds: [idA],
    });
  });

  it("reports not-downloaded when the session has no package ids", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    expect(getOfflineRouteCoverage(snapshot([]), resolver, [0.2, 0.2])).toEqual({
      kind: "not-downloaded",
      packageIds: [],
    });
  });

  it("ignores incompatible packages", async () => {
    const resolver = await resolverWith([
      record(idA, { ...manifest(idA), dataset: { ...manifest(idA).dataset, version: "old" } }),
    ]);
    expect(getOfflineRouteCoverage(snapshot([idA]), resolver, [0.2, 0.2])).toEqual({
      kind: "route-line-only",
      packageIds: [idA],
    });
  });

  it("can report coverage after a package becomes ready", async () => {
    const storage = new MemoryOfflinePackageStorage();
    const resolver = createOfflinePackageResolver(storage, {
      datasetVersion: "dataset-v1",
      styleVersion: "style-v1",
      tileSchema: "openmaptiles",
    });
    await resolver.refresh();
    const first = getOfflineRouteCoverage(snapshot([idB]), resolver, [0.2, 0.2]);
    expect(first.kind).toBe("route-line-only");
    await storage.put(record(idB, manifest(idB)));
    await resolver.refresh();
    expect(getOfflineRouteCoverage(snapshot([idB]), resolver, [0.2, 0.2])).toEqual({
      kind: "covered",
      packageId: idB,
    });
  });
});
