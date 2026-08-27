import type {
  CanonicalOfflinePackageRequest,
  OfflineMapPackageManifest,
  OfflinePackageJob,
  OfflinePackageJobStatus,
  OfflinePackageRequest,
  OfflinePackageSourceDescriptor,
} from "@openmapx/core";
import type { OfflinePackageAccountingStore } from "./accounting.js";

export interface OfflinePackageSourceCatalog {
  descriptor: OfflinePackageSourceDescriptor;
  mbtilesPath: string;
  fontsDirectory: string;
  packageRoot: string;
}

export interface OfflinePackagePreparation {
  jobId: string;
  request: CanonicalOfflinePackageRequest;
  status: OfflinePackageJobStatus;
  packageId?: string;
  manifest?: OfflineMapPackageManifest;
  errorCode?: OfflinePackageJob["errorCode"];
  errorMessage?: string;
}

export interface OfflinePackageGeneratorOptions {
  source: () => OfflinePackageSourceCatalog | Promise<OfflinePackageSourceCatalog>;
  storage: OfflinePackageStorageLike;
  extractor?: OfflinePackageExtractor;
  clock?: () => Date;
  maxConcurrent?: number;
  /** Maximum waiting jobs; running workers are counted separately. */
  maxQueuedJobs?: number;
  /** Hard ceiling for all in-memory job metadata, including terminal diagnostics. */
  maxTrackedJobs?: number;
  /** How long terminal job diagnostics remain addressable by job id. */
  terminalJobRetentionMs?: number;
  maxPackageBytes?: number;
  maxPackageCount?: number;
  maxPackageBytesTotal?: number;
  minFreeBytes?: number;
  logger?: OfflinePackageLogger;
  /** Durable authoritative ownership/quota/lease state. Production supplies PostgreSQL. */
  accounting?: OfflinePackageAccountingStore;
  workerId?: string;
  leaseMs?: number;
}

export interface OfflinePackageLogger {
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface OfflinePackageExtractorOptions {
  sourceMbtilesPath: string;
  destinationPath: string;
  request: CanonicalOfflinePackageRequest;
}

export interface OfflinePackageExtractionMetadata {
  byteLength: number;
  sha256: string;
  etag: string;
  bounds: OfflinePackageSourceDescriptor["sourceBounds"];
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  tileCompression: "none" | "gzip";
  attribution: string[];
  sourceBytesRead: number;
  destinationBytesWritten: number;
  temporaryBytesPeak: number;
}

export type OfflinePackageExtractor = (
  options: OfflinePackageExtractorOptions,
) => Promise<OfflinePackageExtractionMetadata>;

export interface OfflinePackageArchiveHandle {
  path: string;
  byteLength: number;
  release: () => void;
}

export interface StoredOfflinePackage {
  manifest: OfflineMapPackageManifest;
  packageDirectory: string;
  archivePath: string;
  byteLength: number;
}

export interface OfflinePackageStorageUsage {
  packageCount: number;
  byteLength: number;
}

export interface OfflinePackageStorageLike {
  packageDirectory(packageId: string): string;
  temporaryArchivePath(jobId: string): string;
  publishPackage(input: {
    archivePath: string;
    manifest: OfflineMapPackageManifest;
  }): Promise<void>;
  readPublishedManifest(packageId: string): Promise<OfflineMapPackageManifest | undefined>;
  openPublishedArchive(packageId: string): Promise<OfflinePackageArchiveHandle | undefined>;
  listPublishedPackages(): Promise<StoredOfflinePackage[]>;
  reconcileOfflinePackageStorage(): Promise<{ removed: number }>;
  removePackage(packageId: string): Promise<boolean>;
  usage(): Promise<OfflinePackageStorageUsage>;
  freeBytes?(): number;
}

export interface OfflinePackageJobRecord extends OfflinePackagePreparation {
  createdAtMs: number;
  updatedAtMs: number;
}

export function asOfflinePackageJob(record: OfflinePackageJobRecord): OfflinePackagePreparation {
  return {
    jobId: record.jobId,
    request: record.request,
    status: record.status,
    ...(record.packageId ? { packageId: record.packageId } : {}),
    ...(record.manifest ? { manifest: record.manifest } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
  };
}

export type { OfflinePackageRequest };
