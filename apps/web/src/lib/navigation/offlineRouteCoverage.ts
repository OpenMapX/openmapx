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
  const compatible = new Set(resolver.compatiblePackageIds());
  const savedIds = snapshot.packageIds.filter((id) => compatible.has(id));
  const selected = resolver.packageForCoordinate(coordinate, savedIds);
  if (selected) return { kind: "covered", packageId: selected.id };
  if (snapshot.packageIds.length === 0) return { kind: "not-downloaded", packageIds: [] };
  return { kind: "route-line-only", packageIds: snapshot.packageIds };
}
