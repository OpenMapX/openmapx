import type { LngLat, NavigationSessionSnapshot } from "@openmapx/core";
import type { OfflinePackageResolver } from "../offlineAreas/packageResolver";

export type OfflineRouteCoverage =
  | { kind: "covered"; packageId: string }
  | { kind: "route-line-only"; packageIds: string[] }
  | { kind: "not-downloaded"; packageIds: string[] };

/**
 * Keep route-session and map-package coverage separate. The route geometry is
 * local session data; package selection and compatibility stay owned by the
 * Plan A resolver rather than being duplicated in navigation.
 */
export function getOfflineRouteCoverage(
  snapshot: NavigationSessionSnapshot,
  resolver: OfflinePackageResolver,
  coordinate: LngLat,
): OfflineRouteCoverage {
  // Package readiness is live device state. Snapshot IDs are useful
  // diagnostics, but must not hide a package downloaded after the checkpoint
  // or keep reporting one that has since been deleted.
  const selected = resolver.packageForCoordinate(coordinate);
  if (selected) return { kind: "covered", packageId: selected.id };
  const packageIds = resolver.packageIdsForGeometry(snapshot.route.geometry);
  if (packageIds.length === 0) return { kind: "not-downloaded", packageIds: [] };
  return { kind: "route-line-only", packageIds };
}
