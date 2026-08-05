import type { LngLat } from "@openmapx/core";
import type { OfflinePackageResolver } from "../offlineAreas/packageResolver";

export type OfflineRouteCoverage =
  | { kind: "covered"; packageId: string }
  | { kind: "route-line-only"; packageIds: string[] }
  | { kind: "not-downloaded"; packageIds: string[] };

export interface OfflineRouteCoverageInput {
  /** The live fix, snapped to the route when progress is available. */
  coordinate: LngLat;
  /**
   * Sorted package IDs the route line passes through, cached by the caller for
   * as long as both the route geometry and the installed package set hold.
   */
  routePackageIds: readonly string[];
  resolver: OfflinePackageResolver;
}

/**
 * Keep route-session and map-package coverage separate. The route geometry is
 * local session data; package selection and compatibility stay owned by the
 * Plan A resolver rather than being duplicated in navigation.
 */
export function getOfflineRouteCoverage({
  coordinate,
  routePackageIds,
  resolver,
}: OfflineRouteCoverageInput): OfflineRouteCoverage {
  // Package readiness is live device state. Snapshot IDs are useful
  // diagnostics, but must not hide a package downloaded after the checkpoint
  // or keep reporting one that has since been deleted.
  const selected = resolver.packageForCoordinate(coordinate);
  if (selected) return { kind: "covered", packageId: selected.id };
  if (routePackageIds.length === 0) return { kind: "not-downloaded", packageIds: [] };
  return { kind: "route-line-only", packageIds: [...routePackageIds] };
}

/** True when two coverage values describe the same state to the UI. */
export function sameOfflineRouteCoverage(
  a: OfflineRouteCoverage,
  b: OfflineRouteCoverage,
): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "covered") return a.packageId === (b as typeof a).packageId;
  const other = b as Extract<OfflineRouteCoverage, { packageIds: string[] }>;
  return (
    a.packageIds.length === other.packageIds.length &&
    a.packageIds.every((id, index) => id === other.packageIds[index])
  );
}
