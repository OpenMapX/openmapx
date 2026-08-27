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
  type OfflineMapPackageManifest,
  type OfflinePackageCapability,
  type OfflinePackageJob,
  type OfflinePackageRequest,
  validateOfflineMapPackageManifest,
} from "@openmapx/core";
import {
  assertOfflinePackagePrincipal,
  MemoryOfflinePackageAccountingStore,
  type OfflinePackageAccountingStore,
  OfflinePackagePrincipalQuotaError,
} from "./accounting.js";
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
const DEFAULT_MAX_QUEUED_JOBS = 64;
const DEFAULT_MAX_TRACKED_JOBS = 1_024;
const DEFAULT_TERMINAL_JOB_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PACKAGE_BYTES = 2_000_000_000;
const DEFAULT_MAX_PACKAGE_COUNT = 32;
const DEFAULT_MAX_PACKAGE_BYTES_TOTAL = 20_000_000_000;
const DEFAULT_MIN_FREE_BYTES = 1_000_000_000;
const PACKAGE_ID_PREFIX = "omp2-";
const loadCommonJs = createRequire(import.meta.url);
const combineGlyphPbf = loadCommonJs("@mapbox/glyph-pbf-composite") as {
  combine(buffers: Buffer[], fontstack?: string): Buffer | undefined;
};

export class OfflinePackageCapacityError extends Error {
  readonly errorCode = "capacity" as const;

  constructor(message: string) {
    super(`offline package capacity: ${message}`);
    this.name = "OfflinePackageCapacityError";
  }
}

function packageErrorCode(error: unknown): OfflinePackageJob["errorCode"] {
  if (error instanceof OfflinePackageSourceError) return "generation-failed";
  if (error instanceof OfflinePackagePrincipalQuotaError) return "capacity";
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

function positiveInt(value: number | undefined, envName: string, fallback: number): number {
  if (value === undefined) return envPositiveInt(envName, fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
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
    left.attribution.length === right.attribution.length &&
    left.attribution.every((value, index) => value === right.attribution[index]) &&
    equalBbox(left.sourceBounds, right.sourceBounds)
  );
}

export class OfflinePackageGenerator {
  private readonly sourceFactory: OfflinePackageGeneratorOptions["source"];
  private readonly storage: OfflinePackageStorageLike;
  private readonly extractor: OfflinePackageExtractor;
  private readonly clock: () => Date;
  private readonly maxConcurrent: number;
  private readonly maxQueuedJobs: number;
  private readonly maxTrackedJobs: number;
  private readonly terminalJobRetentionMs: number;
  private readonly maxPackageBytes: number;
  private readonly maxPackageCount: number;
  private readonly maxPackageBytesTotal: number;
  private readonly minFreeBytes: number;
  private readonly logger: OfflinePackageLogger | undefined;
  private readonly accounting: OfflinePackageAccountingStore;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly jobs = new Map<string, OfflinePackageJobRecord>();
  private readonly pending: OfflinePackageJobRecord[] = [];
  private readonly inFlightJobIds = new Set<string>();
  private active = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.maxQueuedJobs = positiveInt(
      options.maxQueuedJobs,
      "OFFLINE_PACKAGE_MAX_QUEUED_JOBS",
      DEFAULT_MAX_QUEUED_JOBS,
    );
    this.maxTrackedJobs = positiveInt(
      options.maxTrackedJobs,
      "OFFLINE_PACKAGE_MAX_TRACKED_JOBS",
      DEFAULT_MAX_TRACKED_JOBS,
    );
    this.terminalJobRetentionMs = positiveInt(
      options.terminalJobRetentionMs,
      "OFFLINE_PACKAGE_JOB_RETENTION_MS",
      DEFAULT_TERMINAL_JOB_RETENTION_MS,
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
    this.accounting = options.accounting ?? new MemoryOfflinePackageAccountingStore();
    this.workerId = options.workerId ?? randomUUID();
    this.leaseMs = Math.max(10_000, options.leaseMs ?? 60_000);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return await this.initializing;
    this.initializing = (async () => {
      await this.storage.reconcileOfflinePackageStorage();
      for (const job of await this.accounting.loadRunnable()) {
        await this.ensureTrackingCapacity(job.createdAtMs);
        this.jobs.set(job.jobId, job);
        this.pending.push(job);
      }
      this.initialized = true;
      this.drain();
    })().finally(() => {
      this.initializing = undefined;
    });
    return await this.initializing;
  }

  async prepare(
    principal: string,
    request: OfflinePackageRequest,
  ): Promise<OfflinePackagePreparation> {
    assertOfflinePackagePrincipal(principal);
    await this.initialize();
    await this.pruneTerminalJobs(this.clock().getTime());
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
      await this.ensureTrackingCapacity(job.createdAtMs);
      await this.accounting.admit(principal, job);
      this.jobs.set(job.jobId, job);
      return asOfflinePackageJob(job);
    }

    const packageId = offlinePackageIdForRequest(canonical);
    const existingManifest = await this.storage.readPublishedManifest(packageId);
    if (existingManifest) {
      const now = this.clock().getTime();
      const recovered: OfflinePackageJobRecord = {
        jobId: randomUUID(),
        request: canonical,
        status: "ready-to-download",
        packageId,
        manifest: existingManifest,
        createdAtMs: now,
        updatedAtMs: now,
      };
      await this.ensureTrackingCapacity(now);
      const admission = await this.accounting.admitReady(principal, recovered, existingManifest);
      for (const evictedPackageId of admission.unreferencedPackageIds) {
        await this.storage.removePackage(evictedPackageId);
      }
      this.jobs.set(admission.record.jobId, admission.record);
      return asOfflinePackageJob(admission.record);
    }

    if (this.pending.length >= this.maxQueuedJobs) {
      throw new OfflinePackageCapacityError(
        `preparation queue is full (${this.maxQueuedJobs} waiting jobs)`,
      );
    }
    const now = this.clock().getTime();
    await this.ensureTrackingCapacity(now);
    const job: OfflinePackageJobRecord = {
      jobId: randomUUID(),
      request: canonical,
      status: "preparing",
      packageId,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const admission = await this.accounting.admit(principal, job);
    for (const evictedPackageId of admission.unreferencedPackageIds) {
      await this.storage.removePackage(evictedPackageId);
    }
    this.jobs.set(admission.record.jobId, admission.record);
    if (admission.createdJob) this.pending.push(admission.record);
    this.logger?.info("offline-package.prepare", {
      jobId: admission.record.jobId,
      packageId: admission.record.packageId,
      status: admission.record.status,
      datasetVersion: canonical.source.datasetVersion,
      glyphsVersion: canonical.source.glyphsVersion,
    });
    this.drain();
    return asOfflinePackageJob(admission.record);
  }

  async getJob(principal: string, jobId: string): Promise<OfflinePackagePreparation | undefined> {
    assertOfflinePackagePrincipal(principal);
    await this.pruneTerminalJobs(this.clock().getTime());
    const job = await this.accounting.getOwnedJob(principal, jobId);
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
        await this.accounting.expire(job.jobId, nowMs);
        expired++;
      }
    }
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (this.pending[index]?.status !== "preparing") this.pending.splice(index, 1);
    }
    await this.pruneTerminalJobs(nowMs);
    return expired;
  }

  private async removeTrackedJob(job: OfflinePackageJobRecord): Promise<void> {
    await this.accounting.removeTerminal(job.jobId);
    this.jobs.delete(job.jobId);
  }

  private terminalJobsOldestFirst(): OfflinePackageJobRecord[] {
    return [...this.jobs.values()]
      .filter((job) => job.status !== "preparing")
      .sort(
        (left, right) =>
          left.updatedAtMs - right.updatedAtMs ||
          left.createdAtMs - right.createdAtMs ||
          left.jobId.localeCompare(right.jobId),
      );
  }

  private async pruneTerminalJobs(nowMs: number): Promise<void> {
    for (const job of this.terminalJobsOldestFirst()) {
      if (nowMs - job.updatedAtMs > this.terminalJobRetentionMs) {
        await this.removeTrackedJob(job);
      }
    }
  }

  private async ensureTrackingCapacity(nowMs: number): Promise<void> {
    await this.pruneTerminalJobs(nowMs);
    if (this.jobs.size < this.maxTrackedJobs) return;

    // Under sustained invalid input, retain as much of the diagnostic window
    // as the hard ceiling permits. Never evict running/queued work.
    for (const job of this.terminalJobsOldestFirst()) {
      await this.removeTrackedJob(job);
      if (this.jobs.size < this.maxTrackedJobs) return;
    }
    throw new OfflinePackageCapacityError(
      `job metadata limit is full (${this.maxTrackedJobs} active or queued jobs)`,
    );
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const job = this.pending.shift();
      if (job?.status !== "preparing") continue;
      this.active++;
      this.inFlightJobIds.add(job.jobId);
      void this.accounting
        .claim(job.jobId, this.workerId, this.maxConcurrent, this.leaseMs)
        .then(async (claimed) => {
          if (claimed) await this.run(job);
          else this.scheduleDrainRetry();
        })
        .catch((error) => {
          this.logger?.warn("offline-package.worker.failed", {
            jobId: job.jobId,
            error: packageErrorMessage(error),
          });
          this.scheduleDrainRetry();
        })
        .finally(() => {
          this.inFlightJobIds.delete(job.jobId);
          this.active--;
          this.drain();
        });
    }
  }

  private scheduleDrainRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.reloadRunnableJobs();
      },
      Math.min(1_000, Math.max(100, Math.floor(this.leaseMs / 4))),
    );
    this.retryTimer.unref();
  }

  private async reloadRunnableJobs(): Promise<void> {
    try {
      const records = await this.accounting.loadRunnable();
      const scheduled = new Set([
        ...this.pending.map((item) => item.jobId),
        ...this.inFlightJobIds,
      ]);
      for (const record of records) {
        if (!scheduled.has(record.jobId)) this.pending.push(record);
      }
      this.drain();
    } catch (error) {
      this.logger?.warn("offline-package.queue-reload.failed", {
        error: packageErrorMessage(error),
      });
      this.scheduleDrainRetry();
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
      if (await this.accounting.hasArtifactReference(candidate.manifest.packageId)) continue;
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
    let leaseLost = false;
    const renewTimer = setInterval(
      () => {
        void this.accounting
          .renew(job.jobId, this.workerId, this.leaseMs)
          .then((renewed) => {
            if (!renewed) leaseLost = true;
          })
          .catch((error) => {
            leaseLost = true;
            this.logger?.warn("offline-package.lease-renewal.failed", {
              jobId: job.jobId,
              error: packageErrorMessage(error),
            });
          });
      },
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    renewTimer.unref();
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
      if (leaseLost || !(await this.accounting.renew(job.jobId, this.workerId, this.leaseMs))) {
        throw new Error("offline package durable generation lease was lost");
      }
      await this.storage.publishPackage({ archivePath: temporaryPath, manifest });
      temporaryPath = undefined;
      const completion = await this.accounting.complete(job.jobId, this.workerId, manifest);
      for (const evictedPackageId of completion.unreferencedPackageIds) {
        await this.storage.removePackage(evictedPackageId);
      }
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
      if (error instanceof OfflinePackagePrincipalQuotaError && job.packageId) {
        if (!(await this.accounting.hasArtifactReference(job.packageId))) {
          await this.storage.removePackage(job.packageId);
        }
      }
      if (job.status === "preparing") {
        job.status = "failed";
        job.errorCode = packageErrorCode(error);
        job.errorMessage = packageErrorMessage(error);
        job.updatedAtMs = this.clock().getTime();
        await this.accounting.fail(
          job.jobId,
          this.workerId,
          job.errorCode,
          job.errorMessage,
          job.updatedAtMs,
        );
      }
      this.logger?.warn("offline-package.generation.failed", {
        jobId: job.jobId,
        packageId: job.packageId,
        status: job.status,
        datasetVersion: job.request.source.datasetVersion,
        glyphsVersion: job.request.source.glyphsVersion,
        errorCode: job.errorCode,
        durationMs: Math.max(0, job.updatedAtMs - startedAtMs),
      });
    } finally {
      clearInterval(renewTimer);
    }
  }
}

export type { OfflinePackageGeneratorOptions } from "./types.js";
