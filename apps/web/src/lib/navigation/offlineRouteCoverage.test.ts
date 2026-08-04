import type { Route } from "@openmapx/core";
import { createNavigationSessionSnapshot, type OfflineMapPackageManifest } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { createOfflinePackageResolver } from "../offlineAreas/packageResolver";
import { MemoryOfflinePackageStorage } from "../offlineAreas/packageStorage";
import type { OfflinePackageRecord } from "../offlineAreas/types";
import { getOfflineRouteCoverage } from "./offlineRouteCoverage";

const idA = `omp2-${"a".repeat(64)}`;
const idB = `omp2-${"b".repeat(64)}`;
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
    schemaVersion: 2,
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
    glyphs: {
      version: "glyphs-v1",
      urlTemplate: "/api/offline/packages/glyphs/glyphs-v1/{fontstack}/{range}.pbf",
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

  it("reports not-downloaded when no installed package intersects the route", async () => {
    const resolver = await resolverWith([
      record(idA, manifest(idA, { west: 2, south: 2, east: 3, north: 3 })),
    ]);
    expect(getOfflineRouteCoverage(snapshot([idA]), resolver, [0.2, 0.2])).toEqual({
      kind: "not-downloaded",
      packageIds: [],
    });
  });

  it("uses a package downloaded after the session checkpoint", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    expect(getOfflineRouteCoverage(snapshot([]), resolver, [0.2, 0.2])).toEqual({
      kind: "covered",
      packageId: idA,
    });
  });

  it("reports route-line-only when an installed package intersects the route but not the fix", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    expect(getOfflineRouteCoverage(snapshot([]), resolver, [1.5, 1.5])).toEqual({
      kind: "route-line-only",
      packageIds: [idA],
    });
  });

  it("keeps an older dataset package usable when the tile schema matches", async () => {
    const resolver = await resolverWith([
      record(idA, { ...manifest(idA), dataset: { ...manifest(idA).dataset, version: "old" } }),
    ]);
    expect(getOfflineRouteCoverage(snapshot([idA]), resolver, [0.2, 0.2])).toEqual({
      kind: "covered",
      packageId: idA,
    });
  });

  it("can report coverage after a package becomes ready", async () => {
    const storage = new MemoryOfflinePackageStorage();
    const resolver = createOfflinePackageResolver(storage, {
      tileSchema: "openmaptiles",
    });
    await resolver.refresh();
    const first = getOfflineRouteCoverage(snapshot([idB]), resolver, [0.2, 0.2]);
    expect(first.kind).toBe("not-downloaded");
    await storage.put(record(idB, manifest(idB)));
    await resolver.refresh();
    expect(getOfflineRouteCoverage(snapshot([idB]), resolver, [0.2, 0.2])).toEqual({
      kind: "covered",
      packageId: idB,
    });
  });

  it("associates a package when a route segment crosses its bounds", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    expect(
      resolver.packageIdsForGeometry([
        [-1, 0.5],
        [2, 0.5],
      ]),
    ).toEqual([idA]);
  });
});
