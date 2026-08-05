import {
  isOfflinePackageCompatible,
  type OfflineMapPackageManifest,
  type OfflinePackageBbox,
  type OfflinePackageCompatibility,
  type OfflinePackageLocalStatus,
  selectOfflinePackage,
} from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { createOfflinePackageResolver } from "./packageResolver";
import type { OfflinePackageRecord, OfflinePackageStorage } from "./types";

const COMPATIBILITY: OfflinePackageCompatibility = { tileSchema: "openmaptiles" };

/**
 * Deterministic PRNG (mulberry32). Randomised catalogues must be reproducible,
 * so the tests never touch `Math.random`.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface Probe {
  manifestReads: number;
  bboxReads: number;
  touched: Set<string>;
  reset(): void;
}

function createProbe(): Probe {
  return {
    manifestReads: 0,
    bboxReads: 0,
    touched: new Set<string>(),
    reset() {
      this.manifestReads = 0;
      this.bboxReads = 0;
      this.touched.clear();
    },
  };
}

interface PackageSpec {
  id: string;
  bbox: OfflinePackageBbox;
  generatedAt: string;
  status: OfflinePackageLocalStatus;
  datasetId: string;
  tileSchema: string;
}

function packageIdFor(index: number): string {
  return `omp2-${index.toString(16).padStart(64, "0")}`;
}

/**
 * Builds a record whose manifest and coverage bbox count property reads. The
 * counters make it observable which packages a query actually evaluated the
 * exact predicate against, and whether a query re-read the manifest at all.
 */
function createRecord(spec: PackageSpec, probe?: Probe): OfflinePackageRecord {
  const bbox: OfflinePackageBbox = probe
    ? {
        get west() {
          probe.bboxReads++;
          probe.touched.add(spec.id);
          return spec.bbox.west;
        },
        get south() {
          return spec.bbox.south;
        },
        get east() {
          return spec.bbox.east;
        },
        get north() {
          return spec.bbox.north;
        },
      }
    : { ...spec.bbox };

  const dataset = {
    id: spec.datasetId,
    version: "1",
    generatedAt: spec.generatedAt,
    sourceMaxZoom: 14,
    tileSchema: spec.tileSchema,
  };
  const coverage = { bbox, minZoom: 0, maxZoom: 14 };

  const manifest = (probe
    ? {
        schemaVersion: 2,
        get packageId() {
          probe.manifestReads++;
          return spec.id;
        },
        requestKey: `request-${spec.id}`,
        get dataset() {
          probe.manifestReads++;
          return dataset;
        },
        get coverage() {
          probe.manifestReads++;
          return coverage;
        },
        archive: {
          url: `https://example.invalid/${spec.id}.pmtiles`,
          contentType: "application/vnd.pmtiles",
          byteLength: 1,
          sha256: "0".repeat(64),
          etag: "etag",
        },
        glyphs: { version: "1", urlTemplate: "https://example.invalid/{fontstack}/{range}.pbf" },
        attribution: [],
      }
    : {
        schemaVersion: 2,
        packageId: spec.id,
        requestKey: `request-${spec.id}`,
        dataset,
        coverage,
        archive: {
          url: `https://example.invalid/${spec.id}.pmtiles`,
          contentType: "application/vnd.pmtiles",
          byteLength: 1,
          sha256: "0".repeat(64),
          etag: "etag",
        },
        glyphs: { version: "1", urlTemplate: "https://example.invalid/{fontstack}/{range}.pbf" },
        attribution: [],
      }) as unknown as OfflineMapPackageManifest;

  return {
    id: spec.id,
    name: spec.id,
    manifest,
    status: spec.status,
    bytesReceived: 0,
    bytesTotal: 0,
    verifiedPrefixBytes: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function createStorage(records: readonly OfflinePackageRecord[]): OfflinePackageStorage {
  return { list: async () => [...records] } as unknown as OfflinePackageStorage;
}

const GENERATED_AT = [
  "2026-01-01T00:00:00.000Z",
  "2026-02-01T00:00:00.000Z",
  "2026-03-01T00:00:00.000Z",
];

/**
 * A catalogue with heavy overlap in one cluster, scattered packages elsewhere,
 * duplicated bboxes (equal coverage area) to force the `generatedAt` tiebreak,
 * fully duplicated rank keys to force the package-ID tiebreak, plus a few
 * non-ready and incompatible records.
 */
function createCatalogSpecs(size: number, seed: number): PackageSpec[] {
  const random = createRandom(seed);
  const specs: PackageSpec[] = [];
  for (let index = 0; index < size; index++) {
    const clustered = index % 3 === 0;
    const width = clustered ? 0.5 + random() * 2 : 0.5 + random() * 20;
    const height = clustered ? 0.5 + random() * 2 : 0.5 + random() * 15;
    const west = clustered ? -5 + random() * 10 : -180 + random() * (360 - width);
    const south = clustered ? 45 + random() * 5 : -85 + random() * (170 - height);
    let bbox: OfflinePackageBbox = {
      west,
      south,
      east: west + width,
      north: south + height,
    };
    let generatedAt = GENERATED_AT[Math.floor(random() * GENERATED_AT.length)];

    const previous = specs[index - 1];
    // Equal coverage area on overlapping boxes exercises the `generatedAt`
    // tiebreak; repeating `generatedAt` as well exercises the ID tiebreak.
    if (previous && index % 7 === 0) bbox = { ...previous.bbox };
    if (previous && index % 11 === 0) {
      bbox = { ...previous.bbox };
      generatedAt = previous.generatedAt;
    }

    const status: OfflinePackageLocalStatus =
      index % 17 === 5 ? "downloading" : index % 23 === 7 ? "error" : "ready";
    specs.push({
      id: packageIdFor(index),
      bbox,
      generatedAt,
      status,
      datasetId: index % 29 === 3 ? "other" : "openmapx",
      tileSchema: index % 31 === 9 ? "shortbread" : "openmaptiles",
    });
  }
  return specs;
}

function contains(bbox: OfflinePackageBbox, coordinate: [number, number]): boolean {
  return (
    coordinate[0] >= bbox.west &&
    coordinate[0] <= bbox.east &&
    coordinate[1] >= bbox.south &&
    coordinate[1] <= bbox.north
  );
}

/** Independent copy of the exact segment/bbox test used as the geometry oracle. */
function segmentIntersects(
  bbox: OfflinePackageBbox,
  start: [number, number],
  end: [number, number],
): boolean {
  if (contains(bbox, start) || contains(bbox, end)) return true;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let minimum = 0;
  let maximum = 1;
  for (const [edge, distance] of [
    [start[0] - bbox.west, -dx],
    [bbox.east - start[0], dx],
    [start[1] - bbox.south, -dy],
    [bbox.north - start[1], dy],
  ] as const) {
    if (distance === 0) {
      if (edge < 0) return false;
      continue;
    }
    const ratio = edge / distance;
    if (distance < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function geometryIntersects(
  bbox: OfflinePackageBbox,
  coordinates: readonly [number, number][],
): boolean {
  if (coordinates.some((coordinate) => contains(bbox, coordinate))) return true;
  for (let index = 1; index < coordinates.length; index++) {
    if (segmentIntersects(bbox, coordinates[index - 1], coordinates[index])) return true;
  }
  return false;
}

/** The pre-index resolver behaviour, kept verbatim as the differential oracle. */
function exhaustiveCompatible(
  records: readonly OfflinePackageRecord[],
  allowedPackageIds?: readonly string[],
): OfflinePackageRecord[] {
  const allowed = allowedPackageIds ? new Set(allowedPackageIds) : undefined;
  return records.filter(
    (record) =>
      record.status === "ready" &&
      isOfflinePackageCompatible(record.manifest, COMPATIBILITY) &&
      (!allowed || allowed.has(record.id)),
  );
}

function exhaustivePackageForCoordinate(
  records: readonly OfflinePackageRecord[],
  coordinate: [number, number],
  allowedPackageIds?: readonly string[],
): OfflinePackageRecord | undefined {
  const candidates = exhaustiveCompatible(records, allowedPackageIds);
  const selected = selectOfflinePackage(
    candidates.map((record) => record.manifest),
    { longitude: coordinate[0], latitude: coordinate[1] },
    COMPATIBILITY,
  );
  return selected ? records.find((record) => record.id === selected.packageId) : undefined;
}

function exhaustivePackageIdsForGeometry(
  records: readonly OfflinePackageRecord[],
  coordinates: readonly [number, number][],
): string[] {
  return exhaustiveCompatible(records)
    .filter((record) => geometryIntersects(record.manifest.coverage.bbox, coordinates))
    .map((record) => record.id)
    .sort();
}

function boundaryPoints(bbox: OfflinePackageBbox): [number, number][] {
  const midX = (bbox.west + bbox.east) / 2;
  const midY = (bbox.south + bbox.north) / 2;
  return [
    [bbox.west, bbox.south],
    [bbox.west, bbox.north],
    [bbox.east, bbox.south],
    [bbox.east, bbox.north],
    [midX, bbox.south],
    [midX, bbox.north],
    [bbox.west, midY],
    [bbox.east, midY],
    [bbox.west - 1e-9, midY],
    [bbox.east + 1e-9, midY],
    [midX, bbox.south - 1e-9],
    [midX, bbox.north + 1e-9],
  ];
}

function createRoute(random: () => number, length: number): [number, number][] {
  const route: [number, number][] = [];
  let longitude = -180 + random() * 360;
  let latitude = -80 + random() * 160;
  for (let index = 0; index < length; index++) {
    route.push([longitude, latitude]);
    longitude += (random() - 0.5) * 6;
    latitude += (random() - 0.5) * 4;
  }
  return route;
}

async function createResolverFor(records: readonly OfflinePackageRecord[]) {
  const resolver = createOfflinePackageResolver(createStorage(records), COMPATIBILITY);
  await resolver.refresh();
  return resolver;
}

describe("offline package resolver index", () => {
  it("returns nothing before the first refresh", () => {
    const specs = createCatalogSpecs(8, 1);
    const resolver = createOfflinePackageResolver(
      createStorage(specs.map((spec) => createRecord(spec))),
      COMPATIBILITY,
    );
    expect(resolver.packageForCoordinate([0, 47])).toBeUndefined();
    expect(resolver.packageIdsForGeometry([[0, 47]])).toEqual([]);
    expect(resolver.compatiblePackageIds()).toEqual([]);
    expect(resolver.get(specs[0].id)).toBeUndefined();
  });

  it("keeps empty and single-point geometry behaviour", async () => {
    const records = createCatalogSpecs(32, 2).map((spec) => createRecord(spec));
    const resolver = await createResolverFor(records);
    expect(resolver.packageIdsForGeometry([])).toEqual([]);
    const point: [number, number] = [
      (records[0].manifest.coverage.bbox.west + records[0].manifest.coverage.bbox.east) / 2,
      (records[0].manifest.coverage.bbox.south + records[0].manifest.coverage.bbox.north) / 2,
    ];
    expect(resolver.packageIdsForGeometry([point])).toEqual(
      exhaustivePackageIdsForGeometry(records, [point]),
    );
  });

  it("still exposes non-ready and incompatible records through get()", async () => {
    const specs = createCatalogSpecs(64, 3);
    const records = specs.map((spec) => createRecord(spec));
    const resolver = await createResolverFor(records);
    for (const spec of specs) expect(resolver.get(spec.id)?.id).toBe(spec.id);
    expect(resolver.compatiblePackageIds()).toEqual(
      exhaustiveCompatible(records)
        .map((record) => record.id)
        .sort(),
    );
    const excluded = specs.filter(
      (spec) =>
        spec.status !== "ready" ||
        spec.datasetId !== "openmapx" ||
        spec.tileSchema !== "openmaptiles",
    );
    expect(excluded.length).toBeGreaterThan(0);
    for (const spec of excluded) {
      expect(resolver.compatiblePackageIds()).not.toContain(spec.id);
    }
  });

  it("returns a fresh compatible-id array that callers cannot alias", async () => {
    const records = createCatalogSpecs(8, 4).map((spec) => createRecord(spec));
    const resolver = await createResolverFor(records);
    const first = resolver.compatiblePackageIds();
    first.push("mutated");
    expect(resolver.compatiblePackageIds()).not.toContain("mutated");
  });

  it("breaks ties by area, then newest dataset, then package id", async () => {
    const bbox: OfflinePackageBbox = { west: 0, south: 0, east: 2, north: 2 };
    const specs: PackageSpec[] = [
      // Larger area, listed first: must lose to the smaller box.
      {
        id: packageIdFor(1),
        bbox: { west: -1, south: -1, east: 5, north: 5 },
        generatedAt: GENERATED_AT[2],
        status: "ready",
        datasetId: "openmapx",
        tileSchema: "openmaptiles",
      },
      // Same area and same id ordering as the next one, but older.
      {
        id: packageIdFor(2),
        bbox: { ...bbox },
        generatedAt: GENERATED_AT[0],
        status: "ready",
        datasetId: "openmapx",
        tileSchema: "openmaptiles",
      },
      {
        id: packageIdFor(4),
        bbox: { ...bbox },
        generatedAt: GENERATED_AT[2],
        status: "ready",
        datasetId: "openmapx",
        tileSchema: "openmaptiles",
      },
      // Full tie with the previous entry except for the (larger) package id.
      {
        id: packageIdFor(5),
        bbox: { ...bbox },
        generatedAt: GENERATED_AT[2],
        status: "ready",
        datasetId: "openmapx",
        tileSchema: "openmaptiles",
      },
    ];
    const records = specs.map((spec) => createRecord(spec));
    const resolver = await createResolverFor(records);
    const point: [number, number] = [1, 1];
    expect(resolver.packageForCoordinate(point)?.id).toBe(packageIdFor(4));
    expect(resolver.packageForCoordinate(point)?.id).toBe(
      exhaustivePackageForCoordinate(records, point)?.id,
    );
    // Restricting the allowed set must fall back to the next-ranked package.
    expect(resolver.packageForCoordinate(point, [packageIdFor(2), packageIdFor(5)])?.id).toBe(
      packageIdFor(5),
    );
    expect(resolver.packageForCoordinate(point, [packageIdFor(1)])?.id).toBe(packageIdFor(1));
    expect(resolver.packageForCoordinate(point, [])).toBeUndefined();
  });

  it("finds no package outside every bbox", async () => {
    const specs: PackageSpec[] = [0, 1, 2].map((index) => ({
      id: packageIdFor(index),
      bbox: { west: index * 10, south: 0, east: index * 10 + 1, north: 1 },
      generatedAt: GENERATED_AT[0],
      status: "ready",
      datasetId: "openmapx",
      tileSchema: "openmaptiles",
    }));
    const resolver = await createResolverFor(specs.map((spec) => createRecord(spec)));
    expect(resolver.packageForCoordinate([5, 0.5])).toBeUndefined();
    expect(resolver.packageForCoordinate([0.5, 5])).toBeUndefined();
    expect(resolver.packageForCoordinate([0, 0])?.id).toBe(packageIdFor(0));
    expect(resolver.packageForCoordinate([1, 1])?.id).toBe(packageIdFor(0));
    expect(resolver.packageForCoordinate([10.5, 0.5])?.id).toBe(packageIdFor(1));
  });

  it("rebuilds the snapshot when refresh sees a changed catalogue", async () => {
    const first = createRecord({
      id: packageIdFor(1),
      bbox: { west: 0, south: 0, east: 1, north: 1 },
      generatedAt: GENERATED_AT[0],
      status: "ready",
      datasetId: "openmapx",
      tileSchema: "openmaptiles",
    });
    const second = createRecord({
      id: packageIdFor(2),
      bbox: { west: 10, south: 10, east: 11, north: 11 },
      generatedAt: GENERATED_AT[0],
      status: "ready",
      datasetId: "openmapx",
      tileSchema: "openmaptiles",
    });
    let listed: OfflinePackageRecord[] = [first];
    const storage = { list: async () => [...listed] } as unknown as OfflinePackageStorage;
    const resolver = createOfflinePackageResolver(storage, COMPATIBILITY);
    await resolver.refresh();
    expect(resolver.packageForCoordinate([10.5, 10.5])).toBeUndefined();
    listed = [first, second];
    await resolver.refresh();
    expect(resolver.packageForCoordinate([10.5, 10.5])?.id).toBe(packageIdFor(2));
    listed = [];
    await resolver.refresh();
    expect(resolver.packageForCoordinate([0.5, 0.5])).toBeUndefined();
    expect(resolver.compatiblePackageIds()).toEqual([]);
  });
});

for (const size of [1, 16, 256, 1024]) {
  describe(`offline package resolver differential (${size} packages)`, () => {
    it("matches the exhaustive selection for every probed case", async () => {
      const specs = createCatalogSpecs(size, size * 7919 + 13);
      const records = specs.map((spec) => createRecord(spec));
      const resolver = await createResolverFor(records);
      const random = createRandom(size * 104729 + 7);
      let cases = 0;

      for (let index = 0; index < 150; index++) {
        const point: [number, number] = [-180 + random() * 360, -85 + random() * 170];
        expect(resolver.packageForCoordinate(point)?.id).toBe(
          exhaustivePackageForCoordinate(records, point)?.id,
        );
        cases++;
      }

      // The dense cluster produces many overlapping candidates per point.
      for (let index = 0; index < 100; index++) {
        const point: [number, number] = [-6 + random() * 14, 44 + random() * 9];
        expect(resolver.packageForCoordinate(point)?.id).toBe(
          exhaustivePackageForCoordinate(records, point)?.id,
        );
        cases++;
      }

      for (const spec of specs.slice(0, Math.min(size, 24))) {
        for (const point of boundaryPoints(spec.bbox)) {
          expect(resolver.packageForCoordinate(point)?.id).toBe(
            exhaustivePackageForCoordinate(records, point)?.id,
          );
          cases++;
        }
      }

      for (let index = 0; index < 60; index++) {
        const allowed = specs
          .filter(() => random() < 0.25)
          .map((spec) => spec.id)
          .slice(0, 64);
        const point: [number, number] =
          random() < 0.5
            ? [-6 + random() * 14, 44 + random() * 9]
            : [-180 + random() * 360, -85 + random() * 170];
        expect(resolver.packageForCoordinate(point, allowed)?.id).toBe(
          exhaustivePackageForCoordinate(records, point, allowed)?.id,
        );
        cases++;
      }

      expect(cases).toBe(310 + 12 * Math.min(size, 24));
    });

    it("matches the exhaustive route package IDs", async () => {
      const specs = createCatalogSpecs(size, size * 104729 + 3);
      const records = specs.map((spec) => createRecord(spec));
      const resolver = await createResolverFor(records);
      const random = createRandom(size * 7919 + 29);
      let cases = 0;

      for (let index = 0; index < 12; index++) {
        const route = createRoute(random, 2 + Math.floor(random() * 48));
        expect(resolver.packageIdsForGeometry(route)).toEqual(
          exhaustivePackageIdsForGeometry(records, route),
        );
        cases++;
      }

      // Routes that deliberately cross the dense cluster.
      for (let index = 0; index < 8; index++) {
        const route: [number, number][] = [
          [-6, 44 + random() * 9],
          [8, 44 + random() * 9],
          [-6 + random() * 14, 54],
        ];
        expect(resolver.packageIdsForGeometry(route)).toEqual(
          exhaustivePackageIdsForGeometry(records, route),
        );
        cases++;
      }

      // A dateline-spanning route may collect extra candidates but must not lose
      // a package the exhaustive scan finds.
      const dateline: [number, number][] = [
        [170, 10],
        [-170, 12],
      ];
      expect(resolver.packageIdsForGeometry(dateline)).toEqual(
        exhaustivePackageIdsForGeometry(records, dateline),
      );
      cases++;

      expect(cases).toBe(21);
    });
  });
}

describe("offline package resolver operation counts", () => {
  it("evaluates the exact point predicate only on index candidates", async () => {
    const probe = createProbe();
    const specs = createCatalogSpecs(1024, 4241);
    const specById = new Map(specs.map((spec) => [spec.id, spec]));
    const records = specs.map((spec) => createRecord(spec, probe));
    const resolver = await createResolverFor(records);
    const random = createRandom(918_273);

    probe.reset();
    let indexedTouches = 0;
    let worstTouched = 0;
    const points: [number, number][] = [];
    for (let index = 0; index < 200; index++) {
      const point: [number, number] =
        index % 2 === 0
          ? [-6 + random() * 14, 44 + random() * 9]
          : [-180 + random() * 360, -85 + random() * 170];
      points.push(point);
      probe.touched.clear();
      resolver.packageForCoordinate(point);
      // Every exact test the index triggered must be a package that really
      // contains the point: pruning drops nothing and wastes nothing.
      for (const id of probe.touched) {
        const spec = specById.get(id);
        expect(spec !== undefined && contains(spec.bbox, point)).toBe(true);
      }
      worstTouched = Math.max(worstTouched, probe.touched.size);
      indexedTouches += probe.touched.size;
    }
    // A coordinate query must not re-read manifests: no compatibility refilter,
    // no manifest mapping and no per-call rank recomputation.
    expect(probe.manifestReads).toBe(0);
    expect(worstTouched).toBeLessThan(64);
    expect(indexedTouches).toBeLessThan(points.length * 64);

    // Same queries through the exhaustive path, for the before/after ratio.
    probe.reset();
    for (const point of points) exhaustivePackageForCoordinate(records, point);
    const exhaustiveTouches = probe.bboxReads;
    expect(probe.manifestReads).toBeGreaterThan(0);
    expect(indexedTouches * 20).toBeLessThan(exhaustiveTouches);
  });

  it("exact-tests only conservative bbox candidates for route queries", async () => {
    const probe = createProbe();
    const specs = createCatalogSpecs(1024, 55_667);
    const specById = new Map(specs.map((spec) => [spec.id, spec]));
    const records = specs.map((spec) => createRecord(spec, probe));
    const resolver = await createResolverFor(records);
    const random = createRandom(31_337);
    const compatibleCount = exhaustiveCompatible(records).length;

    probe.reset();
    let indexedTouched = 0;
    const routes: [number, number][][] = [];
    for (let index = 0; index < 20; index++) {
      const route = createRoute(random, 2 + Math.floor(random() * 30));
      routes.push(route);
      probe.touched.clear();
      resolver.packageIdsForGeometry(route);
      const west = Math.min(...route.map((coordinate) => coordinate[0]));
      const east = Math.max(...route.map((coordinate) => coordinate[0]));
      const south = Math.min(...route.map((coordinate) => coordinate[1]));
      const north = Math.max(...route.map((coordinate) => coordinate[1]));
      for (const id of probe.touched) {
        const bbox = specById.get(id)?.bbox;
        expect(bbox).toBeDefined();
        const intersects =
          bbox !== undefined &&
          bbox.west <= east &&
          bbox.east >= west &&
          bbox.south <= north &&
          bbox.north >= south;
        expect(intersects).toBe(true);
      }
      indexedTouched += probe.touched.size;
    }
    expect(probe.manifestReads).toBe(0);
    expect(indexedTouched).toBeLessThan(routes.length * compatibleCount);

    probe.reset();
    for (const route of routes) exhaustivePackageIdsForGeometry(records, route);
    expect(probe.touched.size).toBe(compatibleCount);
  });

  it("builds the index once per refresh, never per query", async () => {
    const probe = createProbe();
    const records = createCatalogSpecs(1024, 8_675_309).map((spec) => createRecord(spec, probe));
    const resolver = await createResolverFor(records);
    const random = createRandom(2024);

    probe.reset();
    for (let index = 0; index < 500; index++) {
      resolver.packageForCoordinate([-180 + random() * 360, -85 + random() * 170]);
    }
    resolver.compatiblePackageIds();
    resolver.packageIdsForGeometry([
      [0, 47],
      [3, 49],
    ]);
    // Rebuilding the snapshot requires reading `manifest.coverage`,
    // `manifest.dataset` and `manifest.packageId`; queries read none of them.
    expect(probe.manifestReads).toBe(0);

    probe.reset();
    await resolver.refresh();
    expect(probe.manifestReads).toBeGreaterThan(0);
  });
});
