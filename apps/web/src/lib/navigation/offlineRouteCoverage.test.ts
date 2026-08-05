import type { LngLat, OfflineMapPackageManifest, Route } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import type { OfflinePackageResolver } from "../offlineAreas/packageResolver";
import { createOfflinePackageResolver } from "../offlineAreas/packageResolver";
import { MemoryOfflinePackageStorage } from "../offlineAreas/packageStorage";
import type { OfflinePackageRecord } from "../offlineAreas/types";
import { getOfflineRouteCoverage, sameOfflineRouteCoverage } from "./offlineRouteCoverage";

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

async function resolverWith(records: OfflinePackageRecord[]) {
  const storage = new MemoryOfflinePackageStorage();
  for (const item of records) await storage.put(item);
  const resolver = createOfflinePackageResolver(storage, {
    tileSchema: "openmaptiles",
  });
  await resolver.refresh();
  return resolver;
}

/** What the hook caches once per (route geometry, resolver generation). */
function routeIds(resolver: OfflinePackageResolver) {
  return resolver.packageIdsForGeometry(route.geometry);
}

function coverage(resolver: OfflinePackageResolver, coordinate: LngLat) {
  return getOfflineRouteCoverage({
    coordinate,
    routePackageIds: routeIds(resolver),
    resolver,
  });
}

describe("offline route coverage", () => {
  it("reports covered for a compatible ready package", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    expect(coverage(resolver, [0.2, 0.2])).toEqual({ kind: "covered", packageId: idA });
  });

  it("reports not-downloaded when no installed package intersects the route", async () => {
    const resolver = await resolverWith([
      record(idA, manifest(idA, { west: 2, south: 2, east: 3, north: 3 })),
    ]);
    expect(coverage(resolver, [0.2, 0.2])).toEqual({ kind: "not-downloaded", packageIds: [] });
  });

  it("uses a package downloaded after the session checkpoint", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    expect(coverage(resolver, [0.2, 0.2])).toEqual({ kind: "covered", packageId: idA });
  });

  it("reports route-line-only when an installed package intersects the route but not the fix", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    expect(coverage(resolver, [1.5, 1.5])).toEqual({
      kind: "route-line-only",
      packageIds: [idA],
    });
  });

  it("keeps an older dataset package usable when the tile schema matches", async () => {
    const resolver = await resolverWith([
      record(idA, { ...manifest(idA), dataset: { ...manifest(idA).dataset, version: "old" } }),
    ]);
    expect(coverage(resolver, [0.2, 0.2])).toEqual({ kind: "covered", packageId: idA });
  });

  it("can report coverage after a package becomes ready", async () => {
    const storage = new MemoryOfflinePackageStorage();
    const resolver = createOfflinePackageResolver(storage, {
      tileSchema: "openmaptiles",
    });
    await resolver.refresh();
    expect(coverage(resolver, [0.2, 0.2]).kind).toBe("not-downloaded");
    await storage.put(record(idB, manifest(idB)));
    await resolver.refresh();
    expect(coverage(resolver, [0.2, 0.2])).toEqual({ kind: "covered", packageId: idB });
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

  it("never scans the route geometry itself", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    const scan = vi.spyOn(resolver, "packageIdsForGeometry");
    const cached = [idA];
    expect(
      getOfflineRouteCoverage({ coordinate: [1.5, 1.5], routePackageIds: cached, resolver }),
    ).toEqual({ kind: "route-line-only", packageIds: [idA] });
    expect(scan).not.toHaveBeenCalled();
  });

  it("returns a defensive copy of the cached route package ids", async () => {
    const resolver = await resolverWith([record(idA, manifest(idA))]);
    const cached = [idA];
    const result = getOfflineRouteCoverage({
      coordinate: [1.5, 1.5],
      routePackageIds: cached,
      resolver,
    });
    expect(result.kind === "route-line-only" && result.packageIds).not.toBe(cached);
  });
});

describe("coverage equality", () => {
  it("treats equal kinds and ids as the same state", () => {
    expect(
      sameOfflineRouteCoverage(
        { kind: "covered", packageId: idA },
        { kind: "covered", packageId: idA },
      ),
    ).toBe(true);
    expect(
      sameOfflineRouteCoverage(
        { kind: "route-line-only", packageIds: [idA, idB] },
        { kind: "route-line-only", packageIds: [idA, idB] },
      ),
    ).toBe(true);
    expect(
      sameOfflineRouteCoverage(
        { kind: "not-downloaded", packageIds: [] },
        { kind: "not-downloaded", packageIds: [] },
      ),
    ).toBe(true);
  });

  it("separates different kinds, ids, order, and lengths", () => {
    expect(
      sameOfflineRouteCoverage(
        { kind: "covered", packageId: idA },
        { kind: "covered", packageId: idB },
      ),
    ).toBe(false);
    expect(
      sameOfflineRouteCoverage(
        { kind: "route-line-only", packageIds: [idA] },
        { kind: "not-downloaded", packageIds: [idA] },
      ),
    ).toBe(false);
    expect(
      sameOfflineRouteCoverage(
        { kind: "route-line-only", packageIds: [idA, idB] },
        { kind: "route-line-only", packageIds: [idB, idA] },
      ),
    ).toBe(false);
    expect(
      sameOfflineRouteCoverage(
        { kind: "route-line-only", packageIds: [idA] },
        { kind: "route-line-only", packageIds: [idA, idB] },
      ),
    ).toBe(false);
  });
});
