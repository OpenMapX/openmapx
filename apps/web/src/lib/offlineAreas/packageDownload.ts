import { type OfflineMapPackageManifest, validateOfflineMapPackageManifest } from "@openmapx/core";
import { type OfflinePackageApi, OfflinePackageApiError } from "./packageApi";
import { type OfflinePackageMetric, recordOfflinePackageMetric } from "./packageMetrics";
import { validateLocalPmtilesArchive } from "./pmtilesReader";
import { resetOfflinePackageRuntime } from "./runtime";
import { Sha256 } from "./sha256";
import type {
  OfflinePackageDownloadProgress,
  OfflinePackageRecord,
  OfflinePackageStorage,
} from "./types";

const PROGRESS_BYTES = 4 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 1_000;
const activeDownloads = new Set<string>();
const downloadFlights = new Map<string, Promise<OfflinePackageRecord>>();

export const OFFLINE_PACKAGE_CHANGED_EVENT = "openmapx:offline-package-changed";

/** Notify map/navigation consumers that package metadata or readiness changed. */
export function notifyOfflinePackageChanged(packageId: string): void {
  resetOfflinePackageRuntime();
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OFFLINE_PACKAGE_CHANGED_EVENT, { detail: { packageId } }));
}

export function hasActiveOfflinePackageDownload(): boolean {
  return activeDownloads.size > 0;
}

function errorCode(error: unknown): string {
  if (error instanceof OfflinePackageApiError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  if (
    error &&
    typeof error === "object" &&
    /quota/i.test(
      `${"name" in error ? String(error.name) : ""}${"message" in error ? String(error.message) : ""}`,
    )
  ) {
    return "quota";
  }
  return "download-failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function parseRangeStart(value: string | null): number | undefined {
  const match = /^bytes (\d+)-\d+\/\d+$/.exec(value ?? "");
  return match ? Number(match[1]) : undefined;
}

async function hashPrefix(
  file: {
    read(offset: number, length: number): Promise<Uint8Array>;
  },
  length: number,
): Promise<Sha256> {
  const hash = new Sha256();
  for (let offset = 0; offset < length; ) {
    const chunk = await file.read(offset, Math.min(1024 * 1024, length - offset));
    if (chunk.byteLength === 0) throw new Error("offline package partial archive is truncated");
    hash.update(chunk);
    offset += chunk.byteLength;
  }
  return hash;
}

function baseRecord(
  manifest: OfflineMapPackageManifest,
  name: string,
  now: number,
): OfflinePackageRecord {
  return {
    id: manifest.packageId,
    name,
    manifest,
    status: "queued",
    bytesReceived: 0,
    bytesTotal: manifest.archive.byteLength,
    verifiedPrefixBytes: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function withOfflinePackageLock<T>(packageId: string, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return await task();
  return await locks.request(
    `openmapx-offline-package:${packageId}`,
    { mode: "exclusive" },
    async () => await task(),
  );
}

export function downloadOfflinePackage(
  api: OfflinePackageApi,
  storage: OfflinePackageStorage,
  rawManifest: OfflineMapPackageManifest,
  options: {
    name?: string;
    signal?: AbortSignal;
    onProgress?: (progress: OfflinePackageDownloadProgress) => void;
    validateStyles?: () => Promise<void>;
    onMetric?: (metric: OfflinePackageMetric) => void;
  } = {},
): Promise<OfflinePackageRecord> {
  const packageId = rawManifest.packageId;
  const existing = downloadFlights.get(packageId);
  if (existing) return existing;

  activeDownloads.add(packageId);
  const operation = withOfflinePackageLock(packageId, () =>
    downloadOfflinePackageImpl(api, storage, rawManifest, options),
  );
  const tracked = operation.finally(() => {
    if (downloadFlights.get(packageId) === tracked) downloadFlights.delete(packageId);
    activeDownloads.delete(packageId);
  });
  downloadFlights.set(packageId, tracked);
  return tracked;
}

async function downloadOfflinePackageImpl(
  api: OfflinePackageApi,
  storage: OfflinePackageStorage,
  rawManifest: OfflineMapPackageManifest,
  options: {
    name?: string;
    signal?: AbortSignal;
    onProgress?: (progress: OfflinePackageDownloadProgress) => void;
    validateStyles?: () => Promise<void>;
    onMetric?: (metric: OfflinePackageMetric) => void;
  } = {},
): Promise<OfflinePackageRecord> {
  const manifest = validateOfflineMapPackageManifest(rawManifest);
  const existing = await storage.get(manifest.packageId);
  let record = existing ?? baseRecord(manifest, options.name ?? "Offline map", Date.now());
  if (record.manifest.archive.etag !== manifest.archive.etag) {
    await storage.delete(manifest.packageId);
    record = baseRecord(manifest, options.name ?? record.name, Date.now());
  }
  record.manifest = manifest;
  record.bytesTotal = manifest.archive.byteLength;
  let attemptStartBytes = 0;

  const report = (
    status: OfflinePackageDownloadProgress["status"],
    startedAt: number,
    error?: { code: string; message: string },
  ) => {
    const elapsed = Math.max(1, Date.now() - startedAt);
    options.onProgress?.({
      packageId: manifest.packageId,
      status,
      bytesReceived: record.bytesReceived,
      bytesTotal: record.bytesTotal,
      speedBytesPerSecond: Math.round(
        (Math.max(0, record.bytesReceived - attemptStartBytes) * 1000) / elapsed,
      ),
      ...(error ? { error } : {}),
    });
  };

  const metric = (input: Parameters<typeof recordOfflinePackageMetric>[0]) => {
    options.onMetric?.(recordOfflinePackageMetric(input));
  };

  const now = Date.now();
  if (
    record.bytesReceived === record.bytesTotal &&
    (record.status === "ready" || record.lastError?.code === "offline-assets-unavailable")
  ) {
    let readyFile: Awaited<ReturnType<OfflinePackageStorage["openReady"]>> | undefined;
    let archiveValid = false;
    try {
      readyFile = await storage.openReady(manifest.packageId);
      await validateLocalPmtilesArchive(readyFile, {
        bounds: manifest.coverage.bbox,
        minZoom: manifest.coverage.minZoom,
        maxZoom: manifest.coverage.maxZoom,
      });
      await readyFile.close();
      archiveValid = true;
      if (options.validateStyles) await options.validateStyles();
      const becameReady = record.status !== "ready";
      record.status = "ready";
      record.lastError = undefined;
      record.updatedAt = Date.now();
      await storage.put(record);
      if (becameReady) notifyOfflinePackageChanged(manifest.packageId);
      metric({
        event: "download",
        packageId: manifest.packageId,
        status: "ready",
        byteLength: manifest.archive.byteLength,
        durationMs: 0,
      });
      return record;
    } catch (error) {
      await readyFile?.close().catch(() => {});
      if (archiveValid) {
        record.status = "error";
        record.lastError = {
          code: "offline-assets-unavailable",
          message: errorMessage(error),
        };
        record.updatedAt = Date.now();
        await storage.put(record);
        throw error;
      }
      await storage.delete(manifest.packageId);
      record = baseRecord(manifest, options.name ?? record.name, Date.now());
    }
  }
  record.status = "downloading";
  record.lastError = undefined;
  record.updatedAt = now;
  await storage.put(record);
  const startedAt = now;
  let verificationStarted = false;
  metric({
    event: "download",
    packageId: manifest.packageId,
    status: "started",
    byteLength: manifest.archive.byteLength,
    retry: record.verifiedPrefixBytes > 0,
  });
  const file = await storage.openPartial(manifest.packageId);
  const existingSize = await file.size();
  let prefix = Math.min(record.verifiedPrefixBytes, existingSize, manifest.archive.byteLength);
  if (existingSize !== prefix || prefix !== record.verifiedPrefixBytes) {
    await file.truncate(prefix);
    record.verifiedPrefixBytes = prefix;
    record.bytesReceived = prefix;
  }
  if (prefix > 0) {
    metric({
      event: "resume",
      packageId: manifest.packageId,
      status: "started",
      byteLength: manifest.archive.byteLength,
      retry: true,
    });
  }
  attemptStartBytes = prefix;

  try {
    const estimate = await storage.estimate();
    const remainingArchiveBytes = manifest.archive.byteLength - prefix;
    if (estimate.available !== undefined && estimate.available < remainingArchiveBytes) {
      throw new DOMException(
        `Offline map needs ${remainingArchiveBytes} more archive bytes but only ${estimate.available} are available`,
        "QuotaExceededError",
      );
    }
    let hash = await hashPrefix(file, prefix);
    record.bytesReceived = prefix;
    record.verifiedPrefixBytes = prefix;
    if (prefix < manifest.archive.byteLength) {
      let response = await api.openArchive(
        manifest.packageId,
        prefix > 0 ? { start: prefix, etag: manifest.archive.etag } : undefined,
        options.signal,
      );
      const rangeStart = parseRangeStart(response.headers.get("content-range"));
      const resumeAccepted =
        prefix > 0 &&
        response.status === 206 &&
        rangeStart === prefix &&
        response.headers.get("etag") === manifest.archive.etag;
      if (prefix > 0 && !resumeAccepted) {
        await response.body?.cancel();
        await file.truncate(0);
        await file.flush();
        prefix = 0;
        record.bytesReceived = 0;
        record.verifiedPrefixBytes = 0;
        attemptStartBytes = 0;
        await storage.put(record);
        hash = new Sha256();
        response = await api.openArchive(manifest.packageId, undefined, options.signal);
      }
      if (
        !response.ok ||
        (prefix > 0 && response.status !== 206) ||
        (prefix === 0 && response.status !== 200)
      ) {
        await response.body?.cancel();
        throw new OfflinePackageApiError(
          `http-${response.status}`,
          response.status,
          `Archive download returned HTTP ${response.status}`,
        );
      }
      if (response.headers.get("etag") !== manifest.archive.etag) {
        await response.body?.cancel();
        throw new Error("offline package archive ETag mismatch");
      }

      let lastPersistedAt = Date.now();
      let lastPersistedBytes = prefix;
      report("downloading", startedAt);
      if (!response.body) throw new Error("offline package archive response has no body");
      const reader = response.body.getReader();
      try {
        while (true) {
          if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const item = await reader.read();
          if (item.done) break;
          const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value);
          await file.append(chunk);
          hash.update(chunk);
          record.bytesReceived += chunk.byteLength;
          record.verifiedPrefixBytes = record.bytesReceived;
          if (
            record.bytesReceived - lastPersistedBytes >= PROGRESS_BYTES ||
            Date.now() - lastPersistedAt >= PROGRESS_INTERVAL_MS
          ) {
            await file.flush();
            record.status = "downloading";
            record.updatedAt = Date.now();
            await storage.put(record);
            lastPersistedBytes = record.bytesReceived;
            lastPersistedAt = Date.now();
            report("downloading", startedAt);
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    await file.flush();
    if (record.bytesReceived !== manifest.archive.byteLength) {
      throw new Error("offline package archive length mismatch");
    }
    if (hash.digestHex() !== manifest.archive.sha256) {
      throw new Error("offline package archive checksum mismatch");
    }

    record.status = "verifying";
    verificationStarted = true;
    record.updatedAt = Date.now();
    await storage.put(record);
    metric({
      event: "verify",
      packageId: manifest.packageId,
      status: "started",
      byteLength: manifest.archive.byteLength,
      durationMs: Date.now() - startedAt,
    });
    report("verifying", startedAt);
    await validateLocalPmtilesArchive(file, {
      bounds: manifest.coverage.bbox,
      minZoom: manifest.coverage.minZoom,
      maxZoom: manifest.coverage.maxZoom,
    });
    if (options.validateStyles) await options.validateStyles();
    await file.close();
    await storage.finalize(manifest.packageId);
    record.status = "ready";
    record.bytesReceived = manifest.archive.byteLength;
    record.verifiedPrefixBytes = manifest.archive.byteLength;
    record.downloadedAt = Date.now();
    record.updatedAt = Date.now();
    await storage.put(record);
    notifyOfflinePackageChanged(manifest.packageId);
    metric({
      event: "download",
      packageId: manifest.packageId,
      status: "ready",
      byteLength: manifest.archive.byteLength,
      durationMs: record.downloadedAt ? record.downloadedAt - startedAt : Date.now() - startedAt,
    });
    report("ready", startedAt);
    return record;
  } catch (error) {
    try {
      await file.flush();
    } catch {
      // Preserve the last successfully persisted prefix below.
    }
    await file.close().catch(() => {});
    const code = errorCode(error);
    const message = errorMessage(error);
    if (isAbort(error)) {
      record.status = "paused";
      record.updatedAt = Date.now();
      await storage.put(record);
      metric({
        event: "download",
        packageId: manifest.packageId,
        status: "paused",
        byteLength: manifest.archive.byteLength,
        durationMs: Date.now() - startedAt,
        errorCode: "aborted",
      });
      report("paused", startedAt, { code: "aborted", message: "Download paused" });
      return record;
    }
    record.status = "error";
    record.lastError = { code, message };
    record.updatedAt = Date.now();
    await storage.put(record);
    metric({
      event:
        code === "quota"
          ? "quota"
          : /checksum/i.test(message)
            ? "checksum"
            : verificationStarted
              ? "verify"
              : "download",
      packageId: manifest.packageId,
      status: "error",
      byteLength: manifest.archive.byteLength,
      durationMs: Date.now() - startedAt,
      errorCode: code,
    });
    report("error", startedAt, record.lastError);
    throw error;
  }
}
