import {
  isOfflinePackageCompatible,
  type OfflineMapPackageManifest,
  type OfflinePackageCompatibility,
  selectOfflinePackage,
} from "@openmapx/core";
import { createOfflinePackageStorage } from "./packageStorage";
import { LocalPmtilesReader } from "./pmtilesReader";
import type { OfflineCoverageState, OfflinePackageRecord, OfflinePackageStorage } from "./types";

export interface OfflinePackageResolver {
  refresh(): Promise<void>;
  packageForCoordinate(
    coordinate: [number, number],
    allowedPackageIds?: readonly string[],
  ): OfflinePackageRecord | undefined;
  coverageForCoordinate(coordinate: [number, number]): OfflineCoverageState;
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

function coverageArea(manifest: OfflineMapPackageManifest): number {
  const { bbox } = manifest.coverage;
  return (bbox.east - bbox.west) * (bbox.north - bbox.south);
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

    coverageForCoordinate(coordinate) {
      const selected = this.packageForCoordinate(coordinate);
      if (selected) return { kind: "covered", packageId: selected.id };
      const incompatible = [...records.values()]
        .filter(
          (record) =>
            record.status === "ready" &&
            contains(record.manifest.coverage.bbox, coordinate) &&
            !isOfflinePackageCompatible(record.manifest, compatibility),
        )
        .sort(
          (a, b) => coverageArea(a.manifest) - coverageArea(b.manifest) || a.id.localeCompare(b.id),
        )[0];
      if (incompatible) {
        return {
          kind: "incompatible",
          packageId: incompatible.id,
          reason: "dataset, style, or tile schema does not match the current map",
        };
      }
      return { kind: "not-downloaded", coordinate };
    },

    packageIdsForGeometry(coordinates) {
      return compatibleRecords()
        .filter((record) =>
          coordinates.some((coordinate) => contains(record.manifest.coverage.bbox, coordinate)),
        )
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
      readers.clear();
    },
  };
}

let defaultResolver: OfflinePackageResolver | undefined;

export function configureDefaultOfflinePackageResolver(
  compatibility: OfflinePackageCompatibility,
): OfflinePackageResolver {
  defaultResolver = createOfflinePackageResolver(createOfflinePackageStorage(), compatibility);
  void defaultResolver.refresh();
  return defaultResolver;
}

export function getDefaultOfflinePackageResolver(): OfflinePackageResolver | undefined {
  return defaultResolver;
}
