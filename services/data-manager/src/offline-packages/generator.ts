import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  extractPmtilesPackage as extractPmtilesPackageServer,
  type PmtilesPackageMetadata,
} from "@openmapx/cli/tile-pmtiles";
import {
  type CanonicalOfflinePackageRequest,
  canonicalizeOfflinePackageRequest,
  OFFLINE_PACKAGE_ALGORITHM_VERSION,
  type OfflineMapPackageManifest,
  type OfflinePackageCapability,
  type OfflinePackageJob,
  type OfflinePackageRequest,
  validateOfflineMapPackageManifest,
} from "@openmapx/core";
import { OfflinePackageSourceError } from "./source-catalog.js";
import type {
  OfflinePackageExtractor,
  OfflinePackageGeneratorOptions,
  OfflinePackageJobRecord,
  OfflinePackageLogger,
  OfflinePackagePreparation,
  OfflinePackageStorageLike,
} from "./types.js";
import { asOfflinePackageJob } from "./types.js";

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_PACKAGE_BYTES = 2_000_000_000;
const DEFAULT_MAX_PACKAGE_COUNT = 32;
const DEFAULT_MAX_PACKAGE_BYTES_TOTAL = 20_000_000_000;
const DEFAULT_MIN_FREE_BYTES = 1_000_000_000;
const PACKAGE_ID_PREFIX = "omp2-";
const loadCommonJs = createRequire(import.meta.url);
const combineGlyphPbf = loadCommonJs("@mapbox/glyph-pbf-composite") as {
  combine(buffers: Buffer[], fontstack?: string): Buffer | undefined;
};

function packageErrorCode(error: unknown): OfflinePackageJob["errorCode"] {
  if (error instanceof OfflinePackageSourceError) return "generation-failed";
  if (error instanceof Error && error.message.startsWith("offline package capacity:")) {
    return "capacity";
  }
  return "generation-failed";
}

function packageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function offlinePackageIdForRequest(request: CanonicalOfflinePackageRequest): string {
  return `${PACKAGE_ID_PREFIX}${createHash("sha256").update(request.requestKey).digest("hex")}`;
}

function equalBbox(
  left: CanonicalOfflinePackageRequest["effective"]["bbox"],
  right: PmtilesPackageMetadata["bounds"],
): boolean {
  return (
    left.west === right.west &&
    left.south === right.south &&
    left.east === right.east &&
    left.north === right.north
  );
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sourceRequestFromManifest(
  manifest: OfflineMapPackageManifest,
): CanonicalOfflinePackageRequest {
  const source = {
    datasetId: manifest.dataset.id,
    datasetVersion: manifest.dataset.version,
    sourceMaxZoom: manifest.dataset.sourceMaxZoom,
    sourceBounds: manifest.coverage.bbox,
    tileSchema: manifest.dataset.tileSchema,
    glyphsVersion: manifest.glyphs.version,
    packageAlgorithmVersion: OFFLINE_PACKAGE_ALGORITHM_VERSION,
    attribution: manifest.attribution,
  } as const;
  const request: OfflinePackageRequest = {
    bbox: manifest.coverage.bbox,
    minZoom: manifest.coverage.minZoom,
    maxZoom: manifest.coverage.maxZoom,
    provider: "openmapx",
  };
  return {
    request,
    effective: {
      bbox: manifest.coverage.bbox,
      minZoom: manifest.coverage.minZoom,
      maxZoom: manifest.coverage.maxZoom,
    },
    source,
    requestKey: manifest.requestKey,
  };
}

function sameSourceDescriptor(
  left: CanonicalOfflinePackageRequest["source"],
  right: CanonicalOfflinePackageRequest["source"],
): boolean {
  return (
    left.datasetId === right.datasetId &&
    left.datasetVersion === right.datasetVersion &&
    left.sourceMaxZoom === right.sourceMaxZoom &&
    left.tileSchema === right.tileSchema &&
    left.glyphsVersion === right.glyphsVersion &&
    left.packageAlgorithmVersion === right.packageAlgorithmVersion &&
    equalBbox(left.sourceBounds, right.sourceBounds)
  );
}

export class OfflinePackageGenerator {
  private readonly sourceFactory: OfflinePackageGeneratorOptions["source"];
  private readonly storage: OfflinePackageStorageLike;
  private readonly extractor: OfflinePackageExtractor;
  private readonly clock: () => Date;
  private readonly maxConcurrent: number;
  private readonly maxPackageBytes: number;
  private readonly maxPackageCount: number;
  private readonly maxPackageBytesTotal: number;
  private readonly minFreeBytes: number;
  private readonly logger: OfflinePackageLogger | undefined;
  private readonly jobs = new Map<string, OfflinePackageJobRecord>();
  private readonly requestJobs = new Map<string, string>();
  private readonly pending: OfflinePackageJobRecord[] = [];
  private active = 0;
  private initialized = false;
  private initializing: Promise<void> | undefined;

  constructor(options: OfflinePackageGeneratorOptions) {
    this.sourceFactory = options.source;
    this.storage = options.storage;
    this.extractor = options.extractor ?? (extractPmtilesPackageServer as OfflinePackageExtractor);
    this.clock = options.clock ?? (() => new Date());
    this.maxConcurrent = Math.max(
      1,
      Math.floor(
        options.maxConcurrent ?? envPositiveInt("OFFLINE_PACKAGE_WORKERS", DEFAULT_MAX_CONCURRENT),
      ),
    );
    this.maxPackageBytes =
      options.maxPackageBytes ??
      envPositiveInt("OFFLINE_PACKAGE_MAX_BYTES", DEFAULT_MAX_PACKAGE_BYTES);
    this.maxPackageCount =
      options.maxPackageCount ??
      envPositiveInt("OFFLINE_PACKAGE_MAX_COUNT", DEFAULT_MAX_PACKAGE_COUNT);
    this.maxPackageBytesTotal =
      options.maxPackageBytesTotal ??
      envPositiveInt("OFFLINE_PACKAGE_MAX_TOTAL_BYTES", DEFAULT_MAX_PACKAGE_BYTES_TOTAL);
    this.minFreeBytes =
      options.minFreeBytes ??
      envPositiveInt("OFFLINE_PACKAGE_MIN_FREE_BYTES", DEFAULT_MIN_FREE_BYTES);
    this.logger = options.logger;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return await this.initializing;
    this.initializing = (async () => {
      await this.storage.reconcileOfflinePackageStorage();
      const packages = await this.storage.listPublishedPackages();
      for (const item of packages) {
        const request = sourceRequestFromManifest(item.manifest);
        const jobId = `recovered-${createHash("sha256").update(item.manifest.packageId).digest("hex").slice(0, 24)}`;
        const now = this.clock().getTime();
        const job: OfflinePackageJobRecord = {
          jobId,
          request,
          status: "ready-to-download",
          packageId: item.manifest.packageId,
          manifest: item.manifest,
          createdAtMs: now,
          updatedAtMs: now,
        };
        this.jobs.set(jobId, job);
        this.requestJobs.set(request.requestKey, jobId);
      }
      this.initialized = true;
    })().finally(() => {
      this.initializing = undefined;
    });
    return await this.initializing;
  }

  async prepare(request: OfflinePackageRequest): Promise<OfflinePackagePreparation> {
    await this.initialize();
    const source = await this.sourceFactory();
    let canonical: CanonicalOfflinePackageRequest;
    try {
      canonical = canonicalizeOfflinePackageRequest(request, source.descriptor);
    } catch (error) {
      const invalidRequest = {
        request: { ...request, bbox: { ...request.bbox } },
        effective: {
          bbox: { ...request.bbox },
          minZoom: request.minZoom,
          maxZoom: request.maxZoom,
        },
        source: source.descriptor,
        requestKey: `invalid-${randomUUID()}`,
      } as CanonicalOfflinePackageRequest;
      const job: OfflinePackageJobRecord = {
        jobId: randomUUID(),
        request: invalidRequest,
        status: "failed",
        errorCode: "invalid-request",
        errorMessage: packageErrorMessage(error),
        createdAtMs: this.clock().getTime(),
        updatedAtMs: this.clock().getTime(),
      };
      this.jobs.set(job.jobId, job);
      return asOfflinePackageJob(job);
    }

    const existingJobId = this.requestJobs.get(canonical.requestKey);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId);
      if (existing && existing.status !== "failed" && existing.status !== "expired") {
        return asOfflinePackageJob(existing);
      }
      // Failed/expired jobs remain addressable by their job ID for diagnostics,
      // but a new preparation request must be able to retry the immutable key.
      this.requestJobs.delete(canonical.requestKey);
    }

    const packageId = offlinePackageIdForRequest(canonical);
    const existingManifest = await this.storage.readPublishedManifest(packageId);
    if (existingManifest) {
      const now = this.clock().getTime();
      const recovered: OfflinePackageJobRecord = {
        jobId: `recovered-${packageId.slice(-24)}`,
        request: canonical,
        status: "ready-to-download",
        packageId,
        manifest: existingManifest,
        createdAtMs: now,
        updatedAtMs: now,
      };
      this.jobs.set(recovered.jobId, recovered);
      this.requestJobs.set(canonical.requestKey, recovered.jobId);
      return asOfflinePackageJob(recovered);
    }

    const job: OfflinePackageJobRecord = {
      jobId: randomUUID(),
      request: canonical,
      status: "preparing",
      packageId,
      createdAtMs: this.clock().getTime(),
      updatedAtMs: this.clock().getTime(),
    };
    this.jobs.set(job.jobId, job);
    this.requestJobs.set(canonical.requestKey, job.jobId);
    this.pending.push(job);
    this.logger?.info("offline-package.prepare", {
      jobId: job.jobId,
      packageId: job.packageId,
      status: job.status,
      datasetVersion: canonical.source.datasetVersion,
      glyphsVersion: canonical.source.glyphsVersion,
    });
    this.drain();
    return asOfflinePackageJob(job);
  }

  getJob(jobId: string): OfflinePackagePreparation | undefined {
    const job = this.jobs.get(jobId);
    return job ? asOfflinePackageJob(job) : undefined;
  }

  async getManifest(packageId: string): Promise<OfflineMapPackageManifest | undefined> {
    await this.initialize();
    return await this.storage.readPublishedManifest(packageId);
  }

  async getCapability(): Promise<OfflinePackageCapability> {
    try {
      const source = await this.sourceFactory();
      return {
        available: true,
        provider: "openmapx",
        datasetVersion: source.descriptor.datasetVersion,
        glyphsVersion: source.descriptor.glyphsVersion,
        sourceMaxZoom: source.descriptor.sourceMaxZoom,
        sourceBounds: source.descriptor.sourceBounds,
      };
    } catch (error) {
      return {
        available: false,
        provider: "openmapx",
        reason: error instanceof OfflinePackageSourceError ? error.reason : "source-unavailable",
      };
    }
  }

  async openArchive(packageId: string) {
    await this.initialize();
    return await this.storage.openPublishedArchive(packageId);
  }

  /** List immutable glyph ranges without making the browser guess Unicode coverage. */
  async glyphCatalog(glyphsVersion: string): Promise<Record<string, string[]> | undefined> {
    await this.initialize();
    const source = await this.sourceFactory();
    if (source.descriptor.glyphsVersion !== glyphsVersion) return undefined;
    const catalog: Record<string, string[]> = {};
    for (const font of readdirSync(source.fontsDirectory, { withFileTypes: true })) {
      if (!font.isDirectory() || font.isSymbolicLink()) continue;
      const ranges = readdirSync(join(source.fontsDirectory, font.name), { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^\d+-\d+\.pbf$/.test(entry.name))
        .map((entry) => entry.name.slice(0, -4))
        .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
      if (ranges.length > 0) catalog[font.name] = ranges;
    }
    return Object.keys(catalog).length > 0 ? catalog : undefined;
  }

  /** Resolve one immutable glyph range from the package's known font archive. */
  async openGlyph(
    glyphsVersion: string,
    rawFontstack: string,
    rawRange: string,
  ): Promise<
    | { path: string; byteLength: number; contentType: string }
    | { body: Uint8Array; byteLength: number; contentType: string }
    | undefined
  > {
    await this.initialize();
    const source = await this.sourceFactory();
    if (source.descriptor.glyphsVersion !== glyphsVersion || !/^\d+-\d+$/.test(rawRange)) {
      return undefined;
    }
    const root = resolve(source.fontsDirectory);
    const resolved = (candidate: string): string | undefined => {
      const value = resolve(candidate);
      return value === root || value.startsWith(`${root}/`) ? value : undefined;
    };
    {
      const fontStacks = rawFontstack.split(",").map((font) => font.trim());
      if (
        fontStacks.some(
          (font) =>
            !font || font.includes("/") || font.includes("\\") || font === "." || font === "..",
        )
      )
        return undefined;

      const paths = fontStacks.map((font) =>
        resolved(join(source.fontsDirectory, font, `${rawRange}.pbf`)),
      );
      if (paths.some((path) => !path)) return undefined;
      try {
        const files = paths as string[];
        if (files.length === 1) {
          const path = files[0];
          if (!lstatSync(path).isFile()) return undefined;
          return {
            path,
            byteLength: statSync(path).size,
            contentType: "application/x-protobuf",
          };
        }
        const body = combineGlyphPbf.combine(
          files.map((path) => readFileSync(path)),
          fontStacks.join(", "),
        );
        if (!body) return undefined;
        return { body, byteLength: body.byteLength, contentType: "application/x-protobuf" };
      } catch {
        return undefined;
      }
    }
  }

  pendingCount(): number {
    return this.pending.length + this.active;
  }

  async reconcileOfflinePackageStorage(): Promise<{ removed: number }> {
    await this.initialize();
    return await this.storage.reconcileOfflinePackageStorage();
  }

  async cancelExpiredOfflinePackageJobs(nowMs = this.clock().getTime()): Promise<number> {
    let expired = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "preparing" && nowMs - job.createdAtMs > 24 * 60 * 60 * 1000) {
        job.status = "expired";
        job.errorCode = "expired";
        job.errorMessage = "offline package preparation expired";
        job.updatedAtMs = nowMs;
        expired++;
      }
    }
    return expired;
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const job = this.pending.shift();
      if (job?.status !== "preparing") continue;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  private async ensureCapacity(datasetVersion: string): Promise<void> {
    const packages = await this.storage.listPublishedPackages();
    let usage = {
      packageCount: packages.length,
      byteLength: packages.reduce((total, item) => total + item.byteLength, 0),
    };

    // Retain the newest package for the current dataset. Older immutable
    // packages are safe eviction candidates when the configured package budget
    // is reached; active archive streams are protected by storage itself.
    const newestCurrent = packages
      .filter((item) => item.manifest.dataset.version === datasetVersion)
      .sort((a, b) =>
        b.manifest.dataset.generatedAt.localeCompare(a.manifest.dataset.generatedAt),
      )[0]?.manifest.packageId;
    const candidates = packages
      .filter((item) => item.manifest.packageId !== newestCurrent)
      .sort(
        (a, b) =>
          a.manifest.dataset.generatedAt.localeCompare(b.manifest.dataset.generatedAt) ||
          a.manifest.packageId.localeCompare(b.manifest.packageId),
      );

    let candidateIndex = 0;
    while (
      usage.packageCount >= this.maxPackageCount ||
      usage.byteLength + this.maxPackageBytes > this.maxPackageBytesTotal
    ) {
      const candidate = candidates[candidateIndex++];
      if (!candidate) {
        throw new Error("offline package capacity: configured package budget is full");
      }
      if (!(await this.storage.removePackage(candidate.manifest.packageId))) continue;
      usage = {
        packageCount: usage.packageCount - 1,
        byteLength: usage.byteLength - candidate.byteLength,
      };
    }

    const freeBytes = this.storage.freeBytes?.();
    if (freeBytes !== undefined && freeBytes - this.minFreeBytes < this.maxPackageBytes * 2) {
      throw new Error("offline package capacity: insufficient temporary disk reserve");
    }
  }

  private async run(job: OfflinePackageJobRecord): Promise<void> {
    let temporaryPath: string | undefined;
    const startedAtMs = this.clock().getTime();
    this.logger?.info("offline-package.generation.started", {
      jobId: job.jobId,
      packageId: job.packageId,
      datasetVersion: job.request.source.datasetVersion,
      glyphsVersion: job.request.source.glyphsVersion,
    });
    try {
      const source = await this.sourceFactory();
      if (!sameSourceDescriptor(job.request.source, source.descriptor)) {
        throw new Error("offline package source changed after preparation; prepare the area again");
      }
      await this.ensureCapacity(source.descriptor.datasetVersion);
      temporaryPath = this.storage.temporaryArchivePath(job.jobId);
      const result = await this.extractor({
        sourceMbtilesPath: source.mbtilesPath,
        destinationPath: temporaryPath,
        request: job.request,
      });
      if (result.byteLength > this.maxPackageBytes) {
        throw new Error("offline package capacity: generated archive exceeds the package limit");
      }
      if (job.status !== "preparing") {
        rmSync(temporaryPath, { force: true });
        temporaryPath = undefined;
        return;
      }
      if (
        !equalBbox(job.request.effective.bbox, result.bounds) ||
        result.minZoom !== job.request.effective.minZoom ||
        result.maxZoom !== job.request.effective.maxZoom
      ) {
        throw new Error("generated PMTiles metadata does not match the canonical request");
      }
      const manifest = validateOfflineMapPackageManifest({
        schemaVersion: 2,
        packageId: job.packageId,
        requestKey: job.request.requestKey,
        dataset: {
          id: "openmapx",
          version: job.request.source.datasetVersion,
          generatedAt: this.clock().toISOString(),
          sourceMaxZoom: job.request.source.sourceMaxZoom,
          tileSchema: job.request.source.tileSchema,
        },
        coverage: {
          bbox: job.request.effective.bbox,
          minZoom: job.request.effective.minZoom,
          maxZoom: job.request.effective.maxZoom,
        },
        archive: {
          url: `/api/offline/packages/${job.packageId}/archive`,
          contentType: "application/vnd.pmtiles",
          byteLength: result.byteLength,
          sha256: result.sha256,
          etag: result.etag,
        },
        glyphs: {
          version: job.request.source.glyphsVersion,
          urlTemplate: `/api/offline/packages/glyphs/${job.request.source.glyphsVersion}/{fontstack}/{range}.pbf`,
        },
        attribution: job.request.source.attribution,
      });
      await this.storage.publishPackage({ archivePath: temporaryPath, manifest });
      temporaryPath = undefined;
      job.manifest = manifest;
      job.status = "ready-to-download";
      job.updatedAtMs = this.clock().getTime();
      this.logger?.info("offline-package.generation.ready", {
        jobId: job.jobId,
        packageId: job.packageId,
        status: job.status,
        datasetVersion: manifest.dataset.version,
        glyphsVersion: manifest.glyphs.version,
        byteLength: manifest.archive.byteLength,
        durationMs: Math.max(0, job.updatedAtMs - startedAtMs),
      });
    } catch (error) {
      if (temporaryPath) rmSync(temporaryPath, { force: true });
      job.status = "failed";
      job.errorCode = packageErrorCode(error);
      job.errorMessage = packageErrorMessage(error);
      job.updatedAtMs = this.clock().getTime();
      this.logger?.warn("offline-package.generation.failed", {
        jobId: job.jobId,
        packageId: job.packageId,
        status: job.status,
        datasetVersion: job.request.source.datasetVersion,
        glyphsVersion: job.request.source.glyphsVersion,
        errorCode: job.errorCode,
        durationMs: Math.max(0, job.updatedAtMs - startedAtMs),
      });
    }
  }
}

export type { OfflinePackageGeneratorOptions } from "./types.js";
