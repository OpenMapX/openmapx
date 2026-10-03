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
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalizeOfflinePackageRequest,
  type OfflineMapPackageManifest,
  type OfflinePackageRequest,
  type OfflinePackageSourceDescriptor,
} from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryOfflinePackageAccountingStore } from "../src/offline-packages/accounting.js";
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
import type { OfflinePackageExtractorOptions } from "../src/offline-packages/types.js";

const roots: string[] = [];
const principal = "a".repeat(64);
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

  it("never evicts physical bytes while an archive stream owns them", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-offline-storage-"));
    roots.push(root);
    const storage = new OfflinePackageStorage(root);
    const packageId = `omp2-${"e".repeat(64)}`;
    const archivePart = storage.temporaryArchivePath("job-streaming");
    writeFileSync(archivePart, "12345678");
    await storage.publishPackage({ archivePath: archivePart, manifest: manifest(packageId) });

    const archive = await storage.openPublishedArchive(packageId);
    expect(archive).toBeDefined();
    await expect(storage.removePackage(packageId)).resolves.toBe(false);
    expect(await storage.readPublishedManifest(packageId)).toMatchObject({ packageId });

    archive?.release();
    await expect(storage.removePackage(packageId)).resolves.toBe(true);
    expect(await storage.readPublishedManifest(packageId)).toBeUndefined();
  });
});

describe("offline package generation", () => {
  it("removes all worker spool files after cancelling real extraction", async () => {
    const dataDir = createDataDir();
    const mbtilesPath = join(dataDir, "tile-mbtiles", "tiles.mbtiles");
    const db = new DatabaseSync(mbtilesPath);
    const tile = db.prepare("INSERT INTO tiles VALUES (12, ?, ?, ?)");
    db.exec("BEGIN");
    for (let x = 2048; x < 2162; x++) {
      for (let y = 2047; y < 2163; y++) tile.run(x, y, Buffer.alloc(2048, 1));
    }
    db.exec("COMMIT");
    db.close();
    const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath,
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage,
      maxPackageBytes: 100_000_000,
      minFreeBytes: 0,
    });
    const temporaryRoot = join(dataDir, "offline-packages", ".tmp");
    const containsSpool = (dir: string): boolean =>
      existsSync(dir) &&
      readdirSync(dir, { withFileTypes: true }).some((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return containsSpool(path);
        return entry.name.endsWith(".tiles") && statSync(path).size > 1_000_000;
      });
    try {
      const job = await generator.prepare(principal, {
        ...request,
        bbox: sourceDescriptor.sourceBounds,
        minZoom: 12,
        maxZoom: 12,
      });
      const deadline = Date.now() + 15_000;
      while (!containsSpool(temporaryRoot) && Date.now() < deadline) await delay(1);
      expect(containsSpool(temporaryRoot)).toBe(true);
      await generator.close();
      expect((await generator.getJob(principal, job.jobId))?.status).toBe("failed");
      expect(readdirSync(temporaryRoot)).toEqual([]);
      expect(await storage.listPublishedPackages()).toEqual([]);
    } finally {
      await generator.close();
    }
  }, 20_000);

  it("stops admission and awaits active extraction cleanup on shutdown", async () => {
    const dataDir = createDataDir();
    const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const extractor = vi.fn(async (options: OfflinePackageExtractorOptions) => {
      await gate;
      writeFileSync(options.destinationPath, "partial");
      throw new Error("interrupted extraction");
    });
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage,
      extractor,
    });
    const job = await generator.prepare(principal, request);
    await vi.waitFor(() => expect(extractor).toHaveBeenCalledOnce());
    let closed = false;
    const closing = generator.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(generator.prepare(principal, request)).rejects.toThrow("closed");
    release();
    await closing;
    expect((await generator.getJob(principal, job.jobId))?.status).toBe("failed");
    expect(existsSync(storage.temporaryArchivePath(job.jobId))).toBe(false);
    expect(await storage.listPublishedPackages()).toEqual([]);
    await generator.close();
  });

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

    const job = await generator.prepare(principal, request);
    await vi.waitFor(async () =>
      expect((await generator.getJob(principal, job.jobId))?.status).toBe("failed"),
    );
    expect((await generator.getJob(principal, job.jobId))?.errorMessage).toContain(
      "source changed",
    );
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

    const first = await generator.prepare(principal, request);
    const second = await generator.prepare(principal, { ...request, bbox: { ...request.bbox } });
    expect(second.jobId).toBe(first.jobId);
    expect(extract).toHaveBeenCalledTimes(1);

    await vi.waitFor(async () => {
      expect((await generator.getJob(principal, first.jobId))?.status).toBe("ready-to-download");
    });
    const ready = await generator.getJob(principal, first.jobId);
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

    const invalid = await generator.prepare(principal, {
      ...request,
      bbox: { west: -1, south: 1, east: 2, north: 2 },
    });
    expect(invalid.status).toBe("failed");
    expect(invalid.errorCode).toBe("invalid-request");
    expect(extract).not.toHaveBeenCalled();

    const first = await generator.prepare(principal, request);
    const second = await generator.prepare(principal, { ...request, maxZoom: 11 });
    expect(second.jobId).not.toBe(first.jobId);
    await vi.waitFor(async () => {
      expect((await generator.getJob(principal, first.jobId))?.status).toBe("failed");
      expect((await generator.getJob(principal, second.jobId))?.status).toBe("failed");
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

    const failed = await generator.prepare(principal, request);
    await vi.waitFor(async () =>
      expect((await generator.getJob(principal, failed.jobId))?.status).toBe("failed"),
    );
    const retry = await generator.prepare(principal, request);

    expect(retry.jobId).not.toBe(failed.jobId);
    await vi.waitFor(async () =>
      expect((await generator.getJob(principal, retry.jobId))?.status).toBe("ready-to-download"),
    );
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
      generator.prepare(principal, request),
      generator.prepare("b".repeat(64), {
        ...request,
        bbox: { west: 2, south: 2, east: 3, north: 3 },
      }),
      generator.prepare("c".repeat(64), {
        ...request,
        bbox: { west: 3, south: 3, east: 4, north: 4 },
      }),
    ]);
    await vi.waitFor(async () =>
      expect((generator as { pendingCount(): number }).pendingCount()).toBe(0),
    );
    expect(peak).toBe(1);
    expect(existsSync(join(dataDir, "offline-packages", "tiles.pmtiles"))).toBe(false);
    expect(statSync(join(dataDir, "tile-mbtiles", "tiles.mbtiles")).size).toBeGreaterThan(0);
    expect(readFileSync(join(dataDir, "tile-mbtiles", "tiles.mbtiles")).length).toBeGreaterThan(0);
  });

  it("keeps invalid-request metadata cardinality bounded under sustained unique input", async () => {
    const dataDir = createDataDir();
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage: new OfflinePackageStorage(join(dataDir, "offline-packages")),
      maxTrackedJobs: 25,
    });
    const ids: string[] = [];

    for (let index = 0; index < 500; index++) {
      const result = await generator.prepare(principal, {
        ...request,
        bbox: { west: -10 - index, south: 1, east: 2, north: 2 },
      });
      ids.push(result.jobId);
    }

    const retained = await Promise.all(ids.map((id) => generator.getJob(principal, id)));
    expect(retained.filter((job) => job !== undefined)).toHaveLength(25);
    expect(await generator.getJob(principal, ids[0] ?? "")).toBeUndefined();
    expect(await generator.getJob(principal, ids.at(-1) ?? "")).toMatchObject({
      status: "failed",
      errorCode: "invalid-request",
    });
  });

  it("rejects excess queued work without allocating another tracked job", async () => {
    const dataDir = createDataDir();
    let releaseExtraction: (() => void) | undefined;
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage: new OfflinePackageStorage(join(dataDir, "offline-packages")),
      extractor: async () => {
        await extractionGate;
        throw new Error("test extraction released");
      },
      maxConcurrent: 1,
      maxQueuedJobs: 1,
      maxTrackedJobs: 10,
    });

    const first = await generator.prepare(principal, request);
    const second = await generator.prepare(principal, {
      ...request,
      bbox: { west: 2, south: 2, east: 3, north: 3 },
    });
    await expect(
      generator.prepare(principal, { ...request, bbox: { west: 3, south: 3, east: 4, north: 4 } }),
    ).rejects.toThrow(/queue.*full/i);
    expect(await generator.getJob(principal, first.jobId)).toBeDefined();
    expect(await generator.getJob(principal, second.jobId)).toBeDefined();

    releaseExtraction?.();
    await vi.waitFor(async () => expect(generator.pendingCount()).toBe(0));
  });

  it("rejects admission at the total metadata ceiling when no terminal job is evictable", async () => {
    const dataDir = createDataDir();
    let releaseExtraction: (() => void) | undefined;
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage: new OfflinePackageStorage(join(dataDir, "offline-packages")),
      extractor: async () => {
        await extractionGate;
        throw new Error("test extraction released");
      },
      maxConcurrent: 1,
      maxQueuedJobs: 10,
      maxTrackedJobs: 2,
    });

    await generator.prepare(principal, request);
    await generator.prepare(principal, {
      ...request,
      bbox: { west: 2, south: 2, east: 3, north: 3 },
    });
    await expect(
      generator.prepare(principal, { ...request, bbox: { west: 3, south: 3, east: 4, north: 4 } }),
    ).rejects.toThrow(/metadata limit.*2/i);

    releaseExtraction?.();
    await vi.waitFor(async () => expect(generator.pendingCount()).toBe(0));
  });

  it("does not re-enqueue a job already running in the same worker", async () => {
    const dataDir = createDataDir();
    let releaseExtraction: (() => void) | undefined;
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    let extractionCount = 0;
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage: new OfflinePackageStorage(join(dataDir, "offline-packages")),
      extractor: async () => {
        extractionCount += 1;
        await extractionGate;
        throw new Error("test extraction released");
      },
      maxConcurrent: 2,
    });

    await generator.prepare(principal, request);
    await generator.prepare(principal, {
      ...request,
      bbox: { west: 2, south: 2, east: 3, north: 3 },
    });
    await vi.waitFor(() => expect(extractionCount).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(extractionCount).toBe(1);

    releaseExtraction?.();
    await vi.waitFor(() => expect(extractionCount).toBe(2), { timeout: 4_000 });
    await vi.waitFor(() => expect(generator.pendingCount()).toBe(0), { timeout: 4_000 });
  });

  it("evicts terminal diagnostics after retention but keeps the published manifest", async () => {
    const dataDir = createDataDir();
    const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
    const canonical = canonicalizeOfflinePackageRequest(request, sourceDescriptor);
    const packageId = offlinePackageIdForRequest(canonical);
    const archivePart = storage.temporaryArchivePath("retained-package");
    writeFileSync(archivePart, "12345678");
    await storage.publishPackage({
      archivePath: archivePart,
      manifest: manifest(packageId, { requestKey: canonical.requestKey }),
    });
    let nowMs = Date.parse("2026-08-20T00:00:00.000Z");
    const generator = new OfflinePackageGenerator({
      source: () => ({
        descriptor: sourceDescriptor,
        mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
        fontsDirectory: join(dataDir, "tile-fonts"),
        packageRoot: join(dataDir, "offline-packages"),
      }),
      storage,
      clock: () => new Date(nowMs),
      terminalJobRetentionMs: 1_000,
    });
    await generator.initialize();
    const recovered = await generator.prepare(principal, request);
    expect(await generator.getJob(principal, recovered.jobId)).toMatchObject({
      status: "ready-to-download",
      packageId,
    });

    nowMs += 1_001;

    expect(await generator.getJob(principal, recovered.jobId)).toBeUndefined();
    await expect(generator.getManifest(packageId)).resolves.toMatchObject({ packageId });
  });
});

function deferredVoid() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

/** Real storage/accounting; only extraction's external tool is replaced. */
function artifactFixture(maxQueuedJobs = 64, maxTrackedJobs = 1_024) {
  const dataDir = createDataDir();
  const storage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
  let now = Date.parse("2026-09-01T10:00:00Z");
  const accounting = new MemoryOfflinePackageAccountingStore({ clock: () => now++ });
  const extract = vi.fn(async (options: OfflinePackageExtractorOptions) => {
    writeFileSync(options.destinationPath, "pmtiles");
    return {
      byteLength: 7,
      sha256: generatedArchiveSha256,
      etag: `sha256-${generatedArchiveSha256}`,
      bounds: options.request.effective.bbox,
      minZoom: options.request.effective.minZoom,
      maxZoom: options.request.effective.maxZoom,
      tileCount: 1,
      tileCompression: "none" as const,
      attribution: sourceDescriptor.attribution,
      sourceBytesRead: 128,
      destinationBytesWritten: 7,
      temporaryBytesPeak: 7,
    };
  });
  const generatorOptions = {
    source: () => ({
      descriptor: sourceDescriptor,
      mbtilesPath: join(dataDir, "tile-mbtiles", "tiles.mbtiles"),
      fontsDirectory: join(dataDir, "tile-fonts"),
      packageRoot: storage.packageRoot,
    }),
    storage,
    accounting,
    extractor: extract,
    maxConcurrent: 1,
    maxQueuedJobs,
    maxTrackedJobs,
    clock: () => new Date(now++),
  };
  const generator = new OfflinePackageGenerator(generatorOptions);
  const area = (index: number): OfflinePackageRequest => ({
    ...request,
    bbox: { west: index + 1, south: 1, east: index + 2, north: 2 },
  });
  const ready = async (index: number, owner = principal) => {
    const job = await generator.prepare(owner, area(index));
    await vi.waitFor(async () =>
      expect((await generator.getJob(owner, job.jobId))?.status).toBe("ready-to-download"),
    );
    await vi.waitFor(() => expect(generator.pendingCount()).toBe(0));
    const completed = await generator.getJob(owner, job.jobId);
    if (!completed?.packageId) throw new Error("Ready fixture has no package ID");
    return { ...completed, packageId: completed.packageId };
  };
  return { generator, generatorOptions, storage, accounting, extract, area, ready };
}

describe("offline worker tracking", () => {
  it.each(["reload", "capacity"])(
    "keeps work admitted during a pending durable snapshot for %s",
    async (operation) => {
      const { generator, accounting, extract, area } = artifactFixture(64, 2);
      const extractionGate = deferredVoid();
      const readStarted = deferredVoid();
      const readGate = deferredVoid();
      const originalExtraction = extract.getMockImplementation();
      if (!originalExtraction) throw new Error("Missing fixture extractor");
      extract.mockImplementationOnce(async (options) => {
        await extractionGate.promise;
        return await originalExtraction(options);
      });
      const first = await generator.prepare(principal, area(0));
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
      if (operation === "capacity") {
        await generator.prepare(principal, {
          ...request,
          bbox: { west: -1, south: 1, east: 2, north: 2 },
        });
      }
      const loadRunnable = accounting.loadRunnable.bind(accounting);
      const read = vi.spyOn(accounting, "loadRunnable").mockImplementationOnce(async () => {
        const snapshot = await loadRunnable();
        readStarted.resolve();
        await readGate.promise;
        return snapshot;
      });
      const worker = generator as unknown as { reloadRunnableJobs(): Promise<void> };
      const pendingOperation = Promise.allSettled([
        operation === "reload"
          ? worker.reloadRunnableJobs()
          : generator.prepare(principal, area(2)),
      ]);
      let queuedId: string | undefined;
      try {
        await readStarted.promise;
        const queued = await generator.prepare(principal, area(1));
        queuedId = queued.jobId;
        readGate.resolve();
        const [result] = await pendingOperation;
        expect(result.status).toBe(operation === "reload" ? "fulfilled" : "rejected");
        expect(generator.pendingCount()).toBe(2);
        extractionGate.resolve();
        await vi.waitFor(() => expect(generator.pendingCount()).toBe(0));
        expect((await generator.getJob(principal, first.jobId))?.status).toBe("ready-to-download");
        expect((await generator.getJob(principal, queued.jobId))?.status).toBe("ready-to-download");
        expect(extract).toHaveBeenCalledTimes(2);
      } finally {
        read.mockRestore();
        readGate.resolve();
        await pendingOperation;
        extractionGate.resolve();
        await worker.reloadRunnableJobs();
        await vi.waitFor(
          async () => {
            if (queuedId)
              expect((await generator.getJob(principal, queuedId))?.status).toBe(
                "ready-to-download",
              );
            expect(generator.pendingCount()).toBe(0);
          },
          { timeout: 4_000 },
        );
      }
    },
  );

  it("does not schedule the same durable job in overlapping reloads", async () => {
    const { generatorOptions, accounting, storage, extract, area } = artifactFixture(64, 2);
    const generator = new OfflinePackageGenerator({ ...generatorOptions, maxConcurrent: 2 });
    await generator.initialize();
    const canonical = canonicalizeOfflinePackageRequest(area(0), sourceDescriptor);
    await accounting.admit(
      principal,
      {
        jobId: "overlapping-reload-job",
        request: canonical,
        packageId: offlinePackageIdForRequest(canonical),
        status: "preparing",
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      { readManifest: (id) => storage.readPublishedManifest(id) },
    );
    const gate = deferredVoid();
    const originalExtraction = extract.getMockImplementation();
    if (!originalExtraction) throw new Error("Missing fixture extractor");
    extract.mockImplementation(async (options) => {
      await gate.promise;
      return await originalExtraction(options);
    });
    const worker = generator as unknown as { reloadRunnableJobs(): Promise<void> };
    try {
      await Promise.all([worker.reloadRunnableJobs(), worker.reloadRunnableJobs()]);
      expect(generator.pendingCount()).toBe(1);
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    } finally {
      gate.resolve();
      await vi.waitFor(() => expect(generator.pendingCount()).toBe(0));
    }
    expect((await generator.getJob(principal, "overlapping-reload-job"))?.status).toBe(
      "ready-to-download",
    );
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("drains a partial durable reload when further records exceed tracking capacity", async () => {
    const { generator, accounting, storage, extract, area } = artifactFixture(64, 1);
    await generator.initialize();
    const jobs = [0, 1].map((index) => {
      const canonical = canonicalizeOfflinePackageRequest(area(index), sourceDescriptor);
      return {
        jobId: `reload-job-${index}`,
        request: canonical,
        packageId: offlinePackageIdForRequest(canonical),
        status: "preparing" as const,
        createdAtMs: index,
        updatedAtMs: index,
      };
    });
    for (const job of jobs) {
      await accounting.admit(principal, job, {
        readManifest: (id) => storage.readPublishedManifest(id),
      });
    }
    const gate = deferredVoid();
    const originalExtraction = extract.getMockImplementation();
    if (!originalExtraction) throw new Error("Missing fixture extractor");
    extract.mockImplementationOnce(async (options) => {
      await gate.promise;
      return await originalExtraction(options);
    });
    const worker = generator as unknown as { reloadRunnableJobs(): Promise<void>; drain(): void };
    try {
      await worker.reloadRunnableJobs();
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
      expect((await generator.getJob(principal, jobs[1].jobId))?.status).toBe("preparing");
    } finally {
      gate.resolve();
      // Also releases the queued first job when the regression is still red.
      worker.drain();
      await vi.waitFor(
        async () => {
          expect((await generator.getJob(principal, jobs[1].jobId))?.status).toBe(
            "ready-to-download",
          );
          expect(generator.pendingCount()).toBe(0);
        },
        { timeout: 4_000 },
      );
    }
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it.each([
    { owner: principal, outcome: "ready-to-download" },
    { owner: "b".repeat(64), outcome: "ready-to-download" },
    { owner: principal, outcome: "failed" },
    { owner: "b".repeat(64), outcome: "failed" },
  ])(
    "admits new work after duplicated jobs become $outcome for $owner",
    async ({ owner, outcome }) => {
      const { generator, extract, area } = artifactFixture(64, 2);
      const originalExtraction = extract.getMockImplementation();
      if (!originalExtraction) throw new Error("Missing fixture extractor");
      const gates = [deferredVoid(), deferredVoid()];
      try {
        for (const [index, gate] of gates.entries()) {
          extract.mockImplementationOnce(async (options) => {
            await gate.promise;
            if (outcome === "failed") throw new Error("test extraction failure");
            return await originalExtraction(options);
          });
          const first = await generator.prepare(principal, area(index));
          await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(index + 1));
          const duplicate = await generator.prepare(owner, area(index));
          expect(duplicate).toMatchObject({ jobId: first.jobId, status: "preparing" });
          gate.resolve();
          await vi.waitFor(() => expect(generator.pendingCount()).toBe(0));
          expect((await generator.getJob(owner, first.jobId))?.status).toBe(outcome);
        }

        const next = await generator.prepare(principal, area(2));
        await vi.waitFor(() => expect(generator.pendingCount()).toBe(0));
        expect((await generator.getJob(principal, next.jobId))?.status).toBe("ready-to-download");
        expect(extract).toHaveBeenCalledTimes(3);
      } finally {
        for (const gate of gates) gate.resolve();
        await vi.waitFor(() => expect(generator.pendingCount()).toBe(0));
      }
    },
  );

  it("reclaims tracking for remotely completed jobs without deleting durable access", async () => {
    const { generator: worker, generatorOptions, storage, extract, area } = artifactFixture();
    const observer = new OfflinePackageGenerator({ ...generatorOptions, maxTrackedJobs: 2 });
    const owner = "b".repeat(64);
    const originalExtraction = extract.getMockImplementation();
    if (!originalExtraction) throw new Error("Missing fixture extractor");
    const gates = [deferredVoid(), deferredVoid()];
    const completedIds: string[] = [];
    try {
      for (const [index, gate] of gates.entries()) {
        extract.mockImplementationOnce(async (options) => {
          await gate.promise;
          return await originalExtraction(options);
        });
        const running = await worker.prepare(principal, area(index));
        await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(index + 1));
        const shared = await observer.prepare(owner, area(index));
        expect(shared.jobId).toBe(running.jobId);
        await vi.waitFor(() => expect(observer.pendingCount()).toBe(0));
        gate.resolve();
        await vi.waitFor(() => expect(worker.pendingCount()).toBe(0));
        expect((await observer.getJob(owner, shared.jobId))?.status).toBe("ready-to-download");
        completedIds.push(shared.jobId);
      }

      const next = await observer.prepare(owner, area(2));
      await vi.waitFor(() => expect(observer.pendingCount()).toBe(0));
      expect((await observer.getJob(owner, next.jobId))?.status).toBe("ready-to-download");
      expect(extract).toHaveBeenCalledTimes(3);
      for (const jobId of completedIds) {
        const completed = await observer.getJob(owner, jobId);
        expect(completed?.status).toBe("ready-to-download");
        expect((await worker.getJob(principal, jobId))?.status).toBe("ready-to-download");
        expect(await storage.readPublishedManifest(completed?.packageId ?? "")).toBeDefined();
      }
    } finally {
      for (const gate of gates) gate.resolve();
      await vi.waitFor(() => expect(worker.pendingCount() + observer.pendingCount()).toBe(0));
    }
  });
});

describe("offline artifact eviction and recovery", () => {
  it.each([principal, "b".repeat(64)])(
    "regenerates evicted bytes for retrying owner %s",
    async (owner) => {
      const { generator, storage, extract, ready } = artifactFixture();
      const first = await ready(0);
      for (let index = 1; index < 6; index++) await ready(index);
      expect(await storage.readPublishedManifest(first.packageId)).toBeUndefined();
      expect(await generator.openArchive(first.packageId)).toBeUndefined();
      const retried = await ready(0, owner);
      expect(retried.jobId).not.toBe(first.jobId);
      expect(extract).toHaveBeenCalledTimes(7);
      const archive = await generator.openArchive(retried.packageId);
      try {
        expect(archive).toBeDefined();
        expect(readFileSync(archive?.path ?? "", "utf8")).toBe("pmtiles");
      } finally {
        archive?.release();
      }
    },
  );

  it("reacquires a quota reference without extracting when a reader prevented deletion", async () => {
    const { generator, storage, accounting, extract, ready } = artifactFixture();
    const first = await ready(0);
    const archive = await generator.openArchive(first.packageId);
    expect(archive).toBeDefined();
    try {
      for (let index = 1; index < 6; index++) await ready(index);
      expect(await accounting.hasArtifactReference(first.packageId)).toBe(false);
      expect(await storage.readPublishedManifest(first.packageId)).toBeDefined();
      expect((await generator.getJob(principal, first.jobId))?.status).toBe("ready-to-download");
      const recovered = await ready(0);
      expect(recovered.jobId).toBe(first.jobId);
      expect(extract).toHaveBeenCalledTimes(6);
      expect(await accounting.hasArtifactReference(first.packageId)).toBe(true);
      expect(await accounting.retainedUsage(principal)).toEqual({
        references: 5,
        logicalBytes: 35,
      });
    } finally {
      archive?.release();
    }
  });

  it.each([false, true])(
    "keeps sixth package ready when old artifact cleanup throws (deleted: %s)",
    async (deleted) => {
      const { generator, storage, extract, ready } = artifactFixture();
      const first = await ready(0);
      const remove = storage.removePackage.bind(storage);
      const spy = vi.spyOn(storage, "removePackage").mockImplementation(async (id) => {
        if (id !== first.packageId) return remove(id);
        if (deleted) await remove(id);
        throw new Error("fixture obsolete artifact cleanup failed");
      });
      try {
        let sixth = first;
        for (let index = 1; index < 6; index++) sixth = await ready(index);
        expect(spy).toHaveBeenCalledWith(first.packageId);
        expect((await generator.getJob(principal, sixth.jobId))?.status).toBe("ready-to-download");
        expect(await storage.readPublishedManifest(sixth.packageId)).toBeDefined();
        const retried = await ready(0);
        expect(extract).toHaveBeenCalledTimes(deleted ? 7 : 6);
        expect(await generator.getManifest(retried.packageId)).toBeDefined();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("admits ready cache hits while the local preparation queue is full", async () => {
    const { generator, extract, area, ready } = artifactFixture(1);
    const cached = await ready(0);
    const gate = deferredVoid();
    const extractNormally = extract.getMockImplementation();
    if (!extractNormally) throw new Error("Missing fixture extractor");
    extract.mockImplementationOnce(async (options) => {
      await gate.promise;
      return extractNormally(options);
    });
    try {
      await generator.prepare(principal, area(1));
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));
      await generator.prepare("b".repeat(64), area(2));
      await expect(generator.prepare("c".repeat(64), area(3))).rejects.toThrow(/queue.*full/i);
      const hit = await generator.prepare(principal, area(0));
      expect(hit).toMatchObject({
        jobId: cached.jobId,
        status: "ready-to-download",
        packageId: cached.packageId,
      });
      expect(extract).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await vi.waitFor(() => expect(generator.pendingCount()).toBe(0));
    }
  });

  it("shares the preparing job while its archive is published but completion is pending", async () => {
    const { generator, storage, extract, area } = artifactFixture(1);
    const gate = deferredVoid();
    const published = deferredVoid();
    const publish = storage.publishPackage.bind(storage);
    const spy = vi.spyOn(storage, "publishPackage").mockImplementationOnce(async (input) => {
      await publish(input);
      published.resolve();
      await gate.promise;
    });
    try {
      const first = await generator.prepare(principal, area(0));
      await published.promise;
      expect(await storage.readPublishedManifest(first.packageId ?? "")).toBeDefined();
      await generator.prepare("b".repeat(64), area(1));
      const shared = await generator.prepare("c".repeat(64), area(0));
      expect(shared).toMatchObject({
        jobId: first.jobId,
        status: "preparing",
        packageId: first.packageId,
      });
      expect(extract).toHaveBeenCalledTimes(1);
      gate.resolve();
      await vi.waitFor(async () =>
        expect((await generator.getJob("c".repeat(64), shared.jobId))?.status).toBe(
          "ready-to-download",
        ),
      );
    } finally {
      gate.resolve();
      await vi.waitFor(() => expect(generator.pendingCount()).toBe(0));
      spy.mockRestore();
    }
  });
});
