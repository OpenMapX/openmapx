import {
  isOfflinePackageCompatible,
  type OfflineMapPackageManifest,
  type OfflinePackageCompatibility,
  selectOfflinePackage,
} from "@openmapx/core";
import { createOfflinePackageStorage } from "./packageStorage";
import { LocalPmtilesReader } from "./pmtilesReader";
import type { OfflinePackageRecord, OfflinePackageStorage } from "./types";

export interface OfflinePackageResolver {
  refresh(): Promise<void>;
  packageForCoordinate(
    coordinate: [number, number],
    allowedPackageIds?: readonly string[],
  ): OfflinePackageRecord | undefined;
  packageIdsForGeometry(coordinates: readonly [number, number][]): string[];
  compatiblePackageIds(): string[];
  get(packageId: string): OfflinePackageRecord | undefined;
  openReader(packageId: string): Promise<LocalPmtilesReader>;
  close(): Promise<void>;
}

function contains(
  bbox: OfflineMapPackageManifest["coverage"]["bbox"],
  coordinate: [number, number],
): boolean {
  return (
    coordinate[0] >= bbox.west &&
    coordinate[0] <= bbox.east &&
    coordinate[1] >= bbox.south &&
    coordinate[1] <= bbox.north
  );
}

function segmentIntersectsBbox(
  bbox: OfflineMapPackageManifest["coverage"]["bbox"],
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

function geometryIntersectsBbox(
  bbox: OfflineMapPackageManifest["coverage"]["bbox"],
  coordinates: readonly [number, number][],
): boolean {
  if (coordinates.some((coordinate) => contains(bbox, coordinate))) return true;
  for (let index = 1; index < coordinates.length; index++) {
    if (segmentIntersectsBbox(bbox, coordinates[index - 1], coordinates[index])) return true;
  }
  return false;
}

export function createOfflinePackageResolver(
  storage: OfflinePackageStorage,
  compatibility: OfflinePackageCompatibility,
): OfflinePackageResolver {
  let records = new Map<string, OfflinePackageRecord>();
  const readers = new Map<string, LocalPmtilesReader>();

  const compatibleRecords = (allowedPackageIds?: readonly string[]) => {
    const allowed = allowedPackageIds ? new Set(allowedPackageIds) : undefined;
    return [...records.values()].filter(
      (record) =>
        record.status === "ready" &&
        isOfflinePackageCompatible(record.manifest, compatibility) &&
        (!allowed || allowed.has(record.id)),
    );
  };

  return {
    async refresh() {
      const next = new Map<string, OfflinePackageRecord>();
      for (const record of await storage.list()) next.set(record.id, record);
      records = next;
      for (const packageId of readers.keys()) {
        if (!records.has(packageId) || records.get(packageId)?.status !== "ready") {
          await readers.get(packageId)?.close();
          readers.delete(packageId);
        }
      }
    },

    packageForCoordinate(coordinate, allowedPackageIds) {
      const candidates = compatibleRecords(allowedPackageIds);
      const selected = selectOfflinePackage(
        candidates.map((record) => record.manifest),
        { longitude: coordinate[0], latitude: coordinate[1] },
        compatibility,
      );
      return selected ? records.get(selected.packageId) : undefined;
    },

    packageIdsForGeometry(coordinates) {
      return compatibleRecords()
        .filter((record) => geometryIntersectsBbox(record.manifest.coverage.bbox, coordinates))
        .map((record) => record.id)
        .sort();
    },

    compatiblePackageIds() {
      return compatibleRecords()
        .map((record) => record.id)
        .sort();
    },

    get(packageId) {
      return records.get(packageId);
    },

    async openReader(packageId) {
      const record = records.get(packageId);
      if (record?.status !== "ready") throw new Error("offline package is not ready");
      if (!isOfflinePackageCompatible(record.manifest, compatibility)) {
        throw new Error("offline package is incompatible with the current map");
      }
      const existing = readers.get(packageId);
      if (existing) return existing;
      const reader = new LocalPmtilesReader(await storage.openReady(packageId));
      readers.set(packageId, reader);
      return reader;
    },

    async close() {
      await Promise.all([...readers.values()].map((reader) => reader.close()));
      readers.clear();
    },
  };
}

let defaultResolver: OfflinePackageResolver | undefined;

export function configureDefaultOfflinePackageResolver(
  compatibility: OfflinePackageCompatibility,
): OfflinePackageResolver {
  if (defaultResolver) return defaultResolver;
  defaultResolver = createOfflinePackageResolver(createOfflinePackageStorage(), compatibility);
  void defaultResolver.refresh();
  return defaultResolver;
}

export function getDefaultOfflinePackageResolver(): OfflinePackageResolver | undefined {
  return defaultResolver;
}
