import { describe, expect, it } from "vitest";
import {
  canonicalizeOfflinePackageRequest,
  type OfflineMapPackageManifest,
  type OfflinePackageSourceDescriptor,
  offlinePackageRequestKey,
  packageContainsPoint,
  selectOfflinePackage,
  validateOfflineMapPackageManifest,
} from "./offlinePackage";

const source: OfflinePackageSourceDescriptor = {
  datasetId: "openmapx",
  datasetVersion: "planetiler-2026-08-01",
  sourceMaxZoom: 14,
  sourceBounds: { west: 5, south: 47, east: 16, north: 55 },
  tileSchema: "openmaptiles",
  glyphsVersion: "openmapx-glyphs-v1",
  packageAlgorithmVersion: "pmtiles-area-v1",
  attribution: ["© OpenStreetMap contributors", "© OpenMapTiles"],
};

function manifest(overrides: Partial<OfflineMapPackageManifest> = {}): OfflineMapPackageManifest {
  const packageId = `omp2-${"a".repeat(64)}`;
  return {
    schemaVersion: 2,
    packageId,
    requestKey: "request-key",
    dataset: {
      id: "openmapx",
      version: source.datasetVersion,
      generatedAt: "2026-08-01T00:00:00.000Z",
      sourceMaxZoom: source.sourceMaxZoom,
      tileSchema: source.tileSchema,
    },
    coverage: {
      bbox: { west: 12, south: 52, east: 14, north: 53 },
      minZoom: 10,
      maxZoom: 14,
    },
    archive: {
      url: `/api/offline/packages/${packageId}/archive`,
      contentType: "application/vnd.pmtiles",
      byteLength: 1024,
      sha256: "a".repeat(64),
      etag: `sha256-${"a".repeat(64)}`,
    },
    glyphs: {
      version: source.glyphsVersion,
      urlTemplate: `/api/offline/packages/glyphs/${source.glyphsVersion}/{fontstack}/{range}.pbf`,
    },
    attribution: source.attribution,
    ...overrides,
  };
}

describe("canonicalizeOfflinePackageRequest", () => {
  it("normalizes coordinate precision and clamps requested max zoom", () => {
    const result = canonicalizeOfflinePackageRequest(
      {
        bbox: { west: 13.4000004, south: 52.49, east: 13.6000004, north: 52.6 },
        minZoom: 10,
        maxZoom: 18,
        provider: "openmapx",
      },
      source,
    );

    expect(result.effective).toEqual({
      bbox: { west: 13.4, south: 52.49, east: 13.6, north: 52.6 },
      minZoom: 10,
      maxZoom: 14,
    });
    expect(result.request.maxZoom).toBe(18);
    expect(result.requestKey).toBe(offlinePackageRequestKey(result));
  });

  it("maps equivalent decimal requests to one key", () => {
    const first = canonicalizeOfflinePackageRequest(
      {
        bbox: { west: 13.4000001, south: 52.49, east: 13.6000001, north: 52.6 },
        minZoom: 10.2,
        maxZoom: 13.8,
        provider: "openmapx",
      },
      source,
    );
    const second = canonicalizeOfflinePackageRequest(
      {
        bbox: { west: 13.4000004, south: 52.49, east: 13.6000004, north: 52.6 },
        minZoom: 10.4,
        maxZoom: 13.6,
        provider: "openmapx",
      },
      source,
    );

    expect(first.requestKey).toBe(second.requestKey);
  });

  it("maps requested overzoom levels with identical package bytes to one key", () => {
    const request = {
      bbox: { west: 13.4, south: 52.49, east: 13.6, north: 52.6 },
      minZoom: 10,
      provider: "openmapx" as const,
    };
    const first = canonicalizeOfflinePackageRequest({ ...request, maxZoom: 15 }, source);
    const second = canonicalizeOfflinePackageRequest({ ...request, maxZoom: 18 }, source);

    expect(first.effective).toEqual(second.effective);
    expect(first.request.maxZoom).not.toBe(second.request.maxZoom);
    expect(first.requestKey).toBe(second.requestKey);
  });

  it("includes PMTiles attribution in the immutable package identity", () => {
    const request: Parameters<typeof canonicalizeOfflinePackageRequest>[0] = {
      bbox: { west: 13.4, south: 52.49, east: 13.6, north: 52.6 },
      minZoom: 10,
      maxZoom: 14,
      provider: "openmapx",
    };
    const first = canonicalizeOfflinePackageRequest(request, source);
    const second = canonicalizeOfflinePackageRequest(request, {
      ...source,
      attribution: [...source.attribution, "© Deployment data"],
    });

    expect(first.requestKey).not.toBe(second.requestKey);
  });

  it("rejects invalid coordinates, zooms, providers, and dateline crossing", () => {
    expect(() =>
      canonicalizeOfflinePackageRequest(
        {
          bbox: { west: Number.NaN, south: 52, east: 14, north: 53 },
          minZoom: 10,
          maxZoom: 14,
          provider: "openmapx",
        },
        source,
      ),
    ).toThrow(/coordinate/i);
    expect(() =>
      canonicalizeOfflinePackageRequest(
        {
          bbox: { west: 14, south: 52, east: 13, north: 53 },
          minZoom: 10,
          maxZoom: 14,
          provider: "openmapx",
        },
        source,
      ),
    ).toThrow(/dateline|west.*east/i);
    expect(() =>
      canonicalizeOfflinePackageRequest(
        {
          bbox: { west: 13, south: 52, east: 14, north: 53 },
          minZoom: -1,
          maxZoom: 14,
          provider: "openmapx",
        },
        source,
      ),
    ).toThrow(/zoom/i);
    expect(() =>
      canonicalizeOfflinePackageRequest(
        {
          bbox: { west: 13, south: 52, east: 14, north: 53 },
          minZoom: 10,
          maxZoom: 14,
          provider: "maptiler" as "openmapx",
        },
        source,
      ),
    ).toThrow(/provider/i);
  });

  it("clamps latitude and rejects requests outside the source bounds", () => {
    const result = canonicalizeOfflinePackageRequest(
      {
        bbox: { west: 13, south: 46, east: 14, north: 90 },
        minZoom: 10,
        maxZoom: 14,
        provider: "openmapx",
      },
      { ...source, sourceBounds: { west: -180, south: -90, east: 180, north: 90 } },
    );
    expect(result.effective.bbox.north).toBe(85.051129);

    expect(() =>
      canonicalizeOfflinePackageRequest(
        {
          bbox: { west: 2, south: 52, east: 4, north: 53 },
          minZoom: 10,
          maxZoom: 14,
          provider: "openmapx",
        },
        source,
      ),
    ).toThrow(/source bounds/i);
  });
});

describe("validateOfflineMapPackageManifest", () => {
  it("accepts a valid immutable package manifest", () => {
    expect(validateOfflineMapPackageManifest(manifest())).toMatchObject({
      packageId: `omp2-${"a".repeat(64)}`,
      archive: { byteLength: 1024 },
    });
  });

  it.each([
    ["schema", { schemaVersion: 1 }],
    ["length", { archive: { ...manifest().archive, byteLength: 0 } }],
    ["hash", { archive: { ...manifest().archive, sha256: "bad" } }],
    ["glyph URL", { glyphs: { ...manifest().glyphs, urlTemplate: "/invalid" } }],
    ["ETag", { archive: { ...manifest().archive, etag: `sha256-${"b".repeat(64)}` } }],
  ])("rejects a manifest with an invalid %s", (_name, override) => {
    expect(() =>
      validateOfflineMapPackageManifest(manifest(override as Partial<OfflineMapPackageManifest>)),
    ).toThrow();
  });
});

describe("offline package coverage selection", () => {
  it("checks coverage and picks the smallest package deterministically", () => {
    const broadId = `omp2-${"b".repeat(64)}`;
    const narrowId = `omp2-${"c".repeat(64)}`;
    const broad = manifest({
      packageId: broadId,
      coverage: { bbox: { west: 10, south: 50, east: 15, north: 54 }, minZoom: 8, maxZoom: 14 },
      archive: { ...manifest().archive, url: `/api/offline/packages/${broadId}/archive` },
    });
    const narrow = manifest({
      packageId: narrowId,
      coverage: { bbox: { west: 12, south: 52, east: 14, north: 53 }, minZoom: 10, maxZoom: 14 },
      archive: { ...manifest().archive, url: `/api/offline/packages/${narrowId}/archive` },
    });

    expect(packageContainsPoint(narrow, { longitude: 13, latitude: 52.5 })).toBe(true);
    expect(packageContainsPoint(narrow, { longitude: 15, latitude: 52.5 })).toBe(false);
    expect(
      selectOfflinePackage(
        [broad, narrow],
        { longitude: 13, latitude: 52.5 },
        {
          tileSchema: source.tileSchema,
        },
      )?.packageId,
    ).toBe(narrowId);
  });

  it("prefers the newest package when equally sized areas overlap", () => {
    const oldId = `omp2-${"d".repeat(64)}`;
    const newId = `omp2-${"e".repeat(64)}`;
    const oldPackage = manifest({
      packageId: oldId,
      dataset: { ...manifest().dataset, generatedAt: "2026-08-01T00:00:00.000Z" },
      archive: { ...manifest().archive, url: `/api/offline/packages/${oldId}/archive` },
    });
    const newPackage = manifest({
      packageId: newId,
      dataset: { ...manifest().dataset, generatedAt: "2026-08-02T00:00:00.000Z" },
      archive: { ...manifest().archive, url: `/api/offline/packages/${newId}/archive` },
    });

    expect(
      selectOfflinePackage(
        [oldPackage, newPackage],
        { longitude: 13, latitude: 52.5 },
        { tileSchema: "openmaptiles" },
      )?.packageId,
    ).toBe(newId);
  });
});
