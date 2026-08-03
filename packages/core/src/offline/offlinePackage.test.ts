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
  styleProvider: "openmapx",
  styleVersion: "openmapx-v1",
  packageAlgorithmVersion: "pmtiles-area-v1",
  attribution: ["© OpenStreetMap contributors", "© OpenMapTiles"],
};

function manifest(overrides: Partial<OfflineMapPackageManifest> = {}): OfflineMapPackageManifest {
  return {
    schemaVersion: 1,
    packageId: "pkg-berlin-v1",
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
      url: "/api/offline/packages/pkg-berlin-v1/archive",
      contentType: "application/vnd.pmtiles",
      byteLength: 1024,
      sha256: "a".repeat(64),
      etag: `sha256-${"a".repeat(64)}`,
    },
    style: {
      provider: "openmapx",
      version: source.styleVersion,
      variants: ["light", "dark"],
      assetBaseUrl: "/styles/openmapx-v1",
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
      packageId: "pkg-berlin-v1",
      archive: { byteLength: 1024 },
    });
  });

  it.each([
    ["schema", { schemaVersion: 2 }],
    ["length", { archive: { ...manifest().archive, byteLength: 0 } }],
    ["hash", { archive: { ...manifest().archive, sha256: "bad" } }],
    ["provider", { style: { ...manifest().style, provider: "maptiler" as "openmapx" } }],
  ])("rejects a manifest with an invalid %s", (_name, override) => {
    expect(() =>
      validateOfflineMapPackageManifest(manifest(override as Partial<OfflineMapPackageManifest>)),
    ).toThrow();
  });
});

describe("offline package coverage selection", () => {
  it("checks coverage and picks the smallest compatible package deterministically", () => {
    const broad = manifest({
      packageId: "pkg-broad",
      coverage: { bbox: { west: 10, south: 50, east: 15, north: 54 }, minZoom: 8, maxZoom: 14 },
      archive: { ...manifest().archive, url: "/api/offline/packages/pkg-broad/archive" },
    });
    const narrow = manifest({
      packageId: "pkg-narrow",
      coverage: { bbox: { west: 12, south: 52, east: 14, north: 53 }, minZoom: 10, maxZoom: 14 },
      archive: { ...manifest().archive, url: "/api/offline/packages/pkg-narrow/archive" },
    });
    const incompatible = manifest({
      packageId: "pkg-incompatible",
      dataset: { ...manifest().dataset, version: "other-dataset" },
      archive: { ...manifest().archive, url: "/api/offline/packages/pkg-incompatible/archive" },
    });

    expect(packageContainsPoint(narrow, { longitude: 13, latitude: 52.5 })).toBe(true);
    expect(packageContainsPoint(narrow, { longitude: 15, latitude: 52.5 })).toBe(false);
    expect(
      selectOfflinePackage(
        [broad, incompatible, narrow],
        { longitude: 13, latitude: 52.5 },
        {
          datasetVersion: source.datasetVersion,
          styleVersion: source.styleVersion,
          tileSchema: source.tileSchema,
        },
      )?.packageId,
    ).toBe("pkg-narrow");
  });
});
