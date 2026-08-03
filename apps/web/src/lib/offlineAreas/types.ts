import type {
  OfflineMapPackageManifest,
  OfflinePackageBbox,
  OfflinePackageLocalStatus,
  OfflinePackageRequest,
} from "@openmapx/core";

export type { OfflinePackageBbox, OfflinePackageLocalStatus, OfflinePackageRequest };

export interface OfflinePackageRecord {
  id: string;
  name: string;
  manifest: OfflineMapPackageManifest;
  status: OfflinePackageLocalStatus;
  bytesReceived: number;
  bytesTotal: number;
  verifiedPrefixBytes: number;
  createdAt: number;
  updatedAt: number;
  downloadedAt?: number;
  lastError?: { code: string; message: string };
}

export interface OfflineArchiveFile {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  append(chunk: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface OfflinePackageStorageEstimate {
  usage?: number;
  quota?: number;
  available?: number;
}

export interface OfflinePackageStorage {
  list(): Promise<OfflinePackageRecord[]>;
  get(packageId: string): Promise<OfflinePackageRecord | undefined>;
  put(record: OfflinePackageRecord): Promise<void>;
  delete(packageId: string): Promise<void>;
  openPartial(packageId: string): Promise<OfflineArchiveFile>;
  finalize(packageId: string): Promise<void>;
  openReady(packageId: string): Promise<OfflineArchiveFile>;
  estimate(): Promise<OfflinePackageStorageEstimate>;
}

export type OfflineCoverageState =
  | { kind: "covered"; packageId: string }
  | { kind: "not-downloaded"; coordinate: [number, number] }
  | { kind: "incompatible"; packageId: string; reason: string };

export interface OfflinePackageDownloadProgress {
  packageId: string;
  status: Extract<
    OfflinePackageLocalStatus,
    "preparing" | "downloading" | "paused" | "verifying" | "ready" | "error"
  >;
  bytesReceived: number;
  bytesTotal: number;
  speedBytesPerSecond: number;
  error?: { code: string; message: string };
}

export interface OfflinePackageStyleAssets {
  manifest: OfflineMapPackageManifest;
  light: Record<string, unknown>;
  dark: Record<string, unknown>;
}

export interface OfflinePackageEventMap {
  ready: { packageId: string };
  deleted: { packageId: string };
  changed: { packageId: string };
}

export type OfflinePackageEventName = keyof OfflinePackageEventMap;

export function packageBbox(record: OfflinePackageRecord): OfflinePackageBbox {
  return record.manifest.coverage.bbox;
}

export function packageRequest(record: OfflinePackageRecord): OfflinePackageRequest {
  return {
    bbox: record.manifest.coverage.bbox,
    minZoom: record.manifest.coverage.minZoom,
    maxZoom: record.manifest.coverage.maxZoom,
    provider: "openmapx",
  };
}
