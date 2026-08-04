import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalizeOfflinePackageRequest,
  type OfflineMapPackageManifest,
  type OfflinePackageRequest,
  type OfflinePackageSourceDescriptor,
} from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OfflinePackageGenerator,
  offlinePackageIdForRequest,
} from "../src/offline-packages/generator.js";
import {
  createOpenMapxPackageSourceFactory,
  getOpenMapxPackageSource,
  OfflinePackageSourceError,
} from "../src/offline-packages/source-catalog.js";
import {
  isContentAddressedPackageId,
  OfflinePackageStorage,
  packageDirectory,
} from "../src/offline-packages/storage.js";

const roots: string[] = [];
const fixtureArchiveSha256 = createHash("sha256").update("12345678").digest("hex");
const generatedArchiveSha256 = createHash("sha256").update("pmtiles").digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createSourceMbtiles(dataDir: string): string {
  const directory = join(dataDir, "tile-mbtiles");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "tiles.mbtiles");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tiles (
      zoom_level INTEGER NOT NULL,
      tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL,
      tile_data BLOB NOT NULL,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
  `);
  const metadata = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  metadata.run("format", "pbf");
  metadata.run("compression", "none");
  metadata.run("bounds", "0,0,10,10");
  metadata.run("minzoom", "1");
  metadata.run("maxzoom", "12");
  metadata.run("version", "fixture-dataset");
  metadata.run("json", JSON.stringify({ vector_layers: [{ id: "transportation", fields: {} }] }));
  db.prepare(
    "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
  ).run(1, 1, 1, Buffer.from("fixture-tile"));
  db.close();
  return path;
}

function createFontTree(dataDir: string): string {
  const root = join(dataDir, "tile-fonts");
  mkdirSync(join(root, "Metropolis"), { recursive: true });
  writeFileSync(join(root, "Metropolis", "0-255.pbf"), "fixture-font");
  return root;
}

function createDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "openmapx-offline-packages-"));
  roots.push(dataDir);
  createSourceMbtiles(dataDir);
  createFontTree(dataDir);
  return dataDir;
}

const sourceDescriptor: OfflinePackageSourceDescriptor = {
  datasetId: "openmapx",
  datasetVersion: "fixture-dataset",
  sourceMaxZoom: 12,
  sourceBounds: { west: 0, south: 0, east: 10, north: 10 },
  tileSchema: "openmaptiles",
  glyphsVersion: "fixture-glyphs-v1",
  packageAlgorithmVersion: "pmtiles-area-v1",
  attribution: ["© OpenStreetMap contributors", "© OpenMapTiles"],
};

const request: OfflinePackageRequest = {
  bbox: { west: 1, south: 1, east: 2, north: 2 },
  minZoom: 1,
  maxZoom: 12,
  provider: "openmapx",
};

function manifest(
  packageId: string,
  overrides: Partial<OfflineMapPackageManifest> = {},
): OfflineMapPackageManifest {
  return {
    schemaVersion: 2,
    packageId,
    requestKey: "fixture-request-key",
    dataset: {
      id: "openmapx",
      version: "fixture-dataset",
      generatedAt: "2026-08-03T00:00:00.000Z",
      sourceMaxZoom: 12,
      tileSchema: "openmaptiles",
    },
    coverage: { bbox: request.bbox, minZoom: 1, maxZoom: 12 },
    archive: {
      url: `/api/offline/packages/${packageId}/archive`,
      contentType: "application/vnd.pmtiles",
      byteLength: 8,
      sha256: fixtureArchiveSha256,
      etag: `sha256-${fixtureArchiveSha256}`,
    },
    glyphs: {
      version: "fixture-glyphs-v1",
      urlTemplate: "/api/offline/packages/glyphs/fixture-glyphs-v1/{fontstack}/{range}.pbf",
    },
    attribution: ["© OpenStreetMap contributors", "© OpenMapTiles"],
    ...overrides,
  };
}

describe("offline package source catalog", () => {
  it("resolves the existing MBTiles source and fonts without creating PMTiles", () => {
    const dataDir = createDataDir();
    const source = getOpenMapxPackageSource(dataDir);

    expect(source.mbtilesPath).toBe(join(dataDir, "tile-mbtiles", "tiles.mbtiles"));
    expect(source.fontsDirectory).toBe(join(dataDir, "tile-fonts"));
    expect(source.descriptor.sourceMaxZoom).toBe(12);
    expect(source.descriptor.sourceBounds).toEqual({ west: 0, south: 0, east: 10, north: 10 });
    expect(source.descriptor.datasetVersion).toContain("fixture-dataset");
    expect(source.descriptor.attribution).toEqual([
      "© OpenStreetMap contributors",
      "© OpenMapTiles",
    ]);
    expect(readdirSync(join(dataDir, "tile-mbtiles"))).toEqual(["tiles.mbtiles"]);
    expect(existsSync(join(dataDir, "tile-mbtiles", "tiles.pmtiles"))).toBe(false);
  });

  it("returns a typed unavailable error when the source is missing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-offline-missing-"));
    roots.push(dataDir);
    expect(() => getOpenMapxPackageSource(dataDir)).toThrow(OfflinePackageSourceError);
  });

  it("reuses a catalog while the atomically managed source roots are unchanged", () => {
    const dataDir = createDataDir();
    const source = createOpenMapxPackageSourceFactory(dataDir);
    expect(source()).toBe(source());
  });
});

describe("offline package storage", () => {
  it("maps only content-addressed IDs below the package root", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-offline-storage-"));
    roots.push(root);
    const storage = new OfflinePackageStorage(root);
    const packageId = `omp2-${"a".repeat(64)}`;

    expect(isContentAddressedPackageId(packageId)).toBe(true);
    expect(storage.packageDirectory(packageId)).toBe(packageDirectory(root, packageId));
    expect(storage.packageDirectory(packageId)).toBe(join(root, packageId));
    expect(() => storage.packageDirectory("../escape")).toThrow();
    expect(() => storage.packageDirectory(".")).toThrow();
    expect(() => storage.packageDirectory("pkg-legacy")).toThrow();
  });

  it("publishes atomically, lists only complete packages, and protects ready packages from cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-offline-storage-"));
    roots.push(root);
    const storage = new OfflinePackageStorage(root);
    const packageId = `omp2-${"b".repeat(64)}`;
    const archivePart = storage.temporaryArchivePath("job-1");
    mkdirSync(join(root, ".tmp"), { recursive: true });
    writeFileSync(archivePart, "12345678");
    await storage.publishPackage({
      archivePath: archivePart,
      manifest: manifest(packageId),
    });

    const published = await storage.readPublishedManifest(packageId);
    expect(published?.packageId).toBe(packageId);
    expect((await storage.listPublishedPackages()).map((item) => item.manifest.packageId)).toEqual([
      packageId,
    ]);
    expect(existsSync(archivePart)).toBe(false);

    writeFileSync(join(root, ".tmp", "orphan.pmtiles.part"), "orphan");
    mkdirSync(join(root, ".tmp", "orphan-dir"));
    await storage.reconcileOfflinePackageStorage();
    expect(existsSync(join(root, ".tmp", "orphan.pmtiles.part"))).toBe(false);
    expect(existsSync(storage.packageDirectory(packageId))).toBe(true);
    expect(await storage.readPublishedManifest(packageId)).not.toBeUndefined();
  });

  it("does not expose an incomplete package and leaves a prior package intact after failed publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-offline-storage-"));
    roots.push(root);
    const storage = new OfflinePackageStorage(root);
    const packageId = `omp2-${"c".repeat(64)}`;
    mkdirSync(storage.packageDirectory(packageId), { recursive: true });
    writeFileSync(join(storage.packageDirectory(packageId), "manifest.json"), "{}");
    expect(await storage.readPublishedManifest(packageId)).toBeUndefined();
    expect(await storage.listPublishedPackages()).toHaveLength(0);

    const archivePart = storage.temporaryArchivePath("job-failed");
    mkdirSync(join(root, ".tmp"), { recursive: true });
    writeFileSync(archivePart, "bad");
    await expect(
      storage.publishPackage({ archivePath: archivePart, manifest: manifest(packageId) }),
    ).rejects.toThrow();
    expect(existsSync(join(storage.packageDirectory(packageId), "manifest.json"))).toBe(true);
  });
});

describe("offline package generation", () => {
  it("fails safely if the source changes between preparation and extraction", async () => {
    const dataDir = createDataDir();
    const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
    const extract = vi.fn();
    let sourceReads = 0;
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor:
          sourceReads++ === 0
            ? sourceDescriptor
            : { ...sourceDescriptor, datasetVersion: "replacement-dataset" },
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage,
      extractor: extract,
    });

    const job = await generator.prepare(request);
    await vi.waitFor(() => expect(generator.getJob(job.jobId)?.status).toBe("failed"));
    expect(generator.getJob(job.jobId)?.errorMessage).toContain("source changed");
    expect(extract).not.toHaveBeenCalled();
  });

  it("shares one job for equal canonical requests and reports measured readiness", async () => {
    const dataDir = createDataDir();
    const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
    const extract = vi.fn(async (options: { destinationPath: string }) => {
      mkdirSync(join(dataDir, "offline-packages", ".tmp"), { recursive: true });
      writeFileSync(options.destinationPath, "pmtiles");
      return {
        byteLength: 7,
        sha256: generatedArchiveSha256,
        etag: `sha256-${generatedArchiveSha256}`,
        bounds: request.bbox,
        minZoom: 1,
        maxZoom: 12,
        tileCount: 1,
        tileCompression: "none" as const,
        attribution: sourceDescriptor.attribution,
        sourceBytesRead: 128,
        destinationBytesWritten: 7,
        temporaryBytesPeak: 7,
      };
    });
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage,
      extractor: extract,
      clock: () => new Date("2026-08-03T00:00:00.000Z"),
      maxConcurrent: 1,
    });

    const first = await generator.prepare(request);
    const second = await generator.prepare({ ...request, bbox: { ...request.bbox } });
    expect(second.jobId).toBe(first.jobId);
    expect(extract).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(generator.getJob(first.jobId)?.status).toBe("ready-to-download");
    });
    const ready = generator.getJob(first.jobId);
    expect(ready?.manifest?.archive.byteLength).toBe(7);
    expect(ready?.manifest?.archive.sha256).toBe(generatedArchiveSha256);
    expect(ready?.packageId).toBe(
      offlinePackageIdForRequest(canonicalizeOfflinePackageRequest(request, sourceDescriptor)),
    );
  });

  it("keeps jobs distinct, rejects invalid coverage before extraction, and preserves old output on failure", async () => {
    const dataDir = createDataDir();
    const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
    const extract = vi.fn(async () => {
      throw new Error("fixture extraction failed");
    });
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage,
      extractor: extract,
      maxConcurrent: 1,
    });

    const invalid = await generator.prepare({
      ...request,
      bbox: { west: -1, south: 1, east: 2, north: 2 },
    });
    expect(invalid.status).toBe("failed");
    expect(invalid.errorCode).toBe("invalid-request");
    expect(extract).not.toHaveBeenCalled();

    const first = await generator.prepare(request);
    const second = await generator.prepare({ ...request, maxZoom: 11 });
    expect(second.jobId).not.toBe(first.jobId);
    await vi.waitFor(() => {
      expect(generator.getJob(first.jobId)?.status).toBe("failed");
      expect(generator.getJob(second.jobId)?.status).toBe("failed");
    });
    expect((await storage.listPublishedPackages()).length).toBe(0);
  });

  it("allows a failed package preparation to be retried", async () => {
    const dataDir = createDataDir();
    const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
    const extract = vi.fn(async (options: { destinationPath: string }) => {
      if (extract.mock.calls.length === 1) throw new Error("temporary extraction failure");
      mkdirSync(join(dataDir, "offline-packages", ".tmp"), { recursive: true });
      writeFileSync(options.destinationPath, "pmtiles");
      return {
        byteLength: 7,
        sha256: generatedArchiveSha256,
        etag: `sha256-${generatedArchiveSha256}`,
        bounds: request.bbox,
        minZoom: 1,
        maxZoom: 12,
        tileCount: 1,
        tileCompression: "none" as const,
        attribution: sourceDescriptor.attribution,
        sourceBytesRead: 128,
        destinationBytesWritten: 7,
        temporaryBytesPeak: 7,
      };
    });
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage,
      extractor: extract,
      maxConcurrent: 1,
    });

    const failed = await generator.prepare(request);
    await vi.waitFor(() => expect(generator.getJob(failed.jobId)?.status).toBe("failed"));
    const retry = await generator.prepare(request);

    expect(retry.jobId).not.toBe(failed.jobId);
    await vi.waitFor(() => expect(generator.getJob(retry.jobId)?.status).toBe("ready-to-download"));
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("limits concurrent extractions and does not retain a full-dataset PMTiles derivative", async () => {
    const dataDir = createDataDir();
    const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
    let active = 0;
    let peak = 0;
    const extract = vi.fn(async (options: { destinationPath: string }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      mkdirSync(join(dataDir, "offline-packages", ".tmp"), { recursive: true });
      writeFileSync(options.destinationPath, "pmtiles");
      active--;
      return {
        byteLength: 7,
        sha256: generatedArchiveSha256,
        etag: `sha256-${generatedArchiveSha256}`,
        bounds: request.bbox,
        minZoom: 1,
        maxZoom: 12,
        tileCount: 1,
        tileCompression: "none" as const,
        attribution: sourceDescriptor.attribution,
        sourceBytesRead: 128,
        destinationBytesWritten: 7,
        temporaryBytesPeak: 7,
      };
    });
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage,
      extractor: extract,
      maxConcurrent: 1,
    });
    await Promise.all([
      generator.prepare(request),
      generator.prepare({ ...request, bbox: { west: 2, south: 2, east: 3, north: 3 } }),
      generator.prepare({ ...request, bbox: { west: 3, south: 3, east: 4, north: 4 } }),
    ]);
    await vi.waitFor(() =>
      expect((generator as { pendingCount(): number }).pendingCount()).toBe(0),
    );
    expect(peak).toBe(1);
    expect(existsSync(join(dataDir, "offline-packages", "tiles.pmtiles"))).toBe(false);
    expect(statSync(join(dataDir, "tile-mbtiles", "tiles.mbtiles")).size).toBeGreaterThan(0);
    expect(readFileSync(join(dataDir, "tile-mbtiles", "tiles.mbtiles")).length).toBeGreaterThan(0);
  });
});
