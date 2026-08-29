"use client";

import {
  resolveTravelTimeBackend,
  useTravelTimeStore,
} from "@integrations/overlay-tool-travel-time/store";
import {
  MAX_TRANSIT_REACHABILITY_DESTINATIONS,
  pointInIsochroneGeometry,
  TRANSIT_WALK_PROFILE,
  type TransitReachabilityCheckRequest,
  type TransitReachabilityCheckResult,
  type TransitReachabilitySurfaceRequest,
  useExploreResults,
  useIsochrone,
  useTransitReachability,
  useTransitReachabilityCheck,
} from "@openmapx/core";
import { useEffect, useMemo } from "react";

type ReachablePlace = { id: string; coordinates: readonly [number, number] };

/** Reject partial, duplicate, unexpected, or stale result IDs as a whole. */
export function applyExactTransitReachability<T extends ReachablePlace>(
  places: readonly T[],
  result: TransitReachabilityCheckResult | undefined,
): T[] | null {
  if (!result || result.results.length !== places.length) return null;
  const expected = new Set(places.map(({ id }) => id));
  const reachable = new Set<string>();
  const seen = new Set<string>();
  for (const item of result.results) {
    if (!expected.has(item.id) || seen.has(item.id)) return null;
    seen.add(item.id);
    if (item.reachable) reachable.add(item.id);
  }
  if (seen.size !== expected.size) return null;
  return places.filter(({ id }) => reachable.has(id));
}

/**
 * Explore results with guarded travel-time filtering. Transit filtering uses
 * exact local MOTIS point checks only; every POI remains visible while the
 * capability/check is pending, unavailable, malformed, or failed.
 */
export function useExploreReachResults(lang?: string) {
  const base = useExploreResults(lang);
  const isActive = useTravelTimeStore((s) => s.isActive);
  const anchored = useTravelTimeStore((s) => s.anchored);
  const onlyWithinReach = useTravelTimeStore((s) => s.onlyWithinReach);
  const origin = useTravelTimeStore((s) => s.origin);
  const mode = useTravelTimeStore((s) => s.mode);
  const selectedMinutes = useTravelTimeStore((s) => s.selectedMinutes);
  const queryTime = useTravelTimeStore((s) => s.queryTime);
  const setTransitFilterState = useTravelTimeStore((s) => s.setTransitFilterState);
  const transitFilterState = useTravelTimeStore((s) => s.transitFilterState);

  const backend = resolveTravelTimeBackend(mode);
  const isTransit = backend.kind === "transit-reachability";
  const toolAnchored = isActive && anchored && origin !== null;
  const filterRequested = toolAnchored && onlyWithinReach;

  const { data: isochroneData } = useIsochrone({
    origin,
    mode: backend.kind === "street-isochrone" ? backend.mode : "walking",
    contourMinutes: selectedMinutes,
    enabled: toolAnchored && !isTransit,
  });

  const surfaceRequest = useMemo<TransitReachabilitySurfaceRequest | null>(() => {
    if (!toolAnchored || !isTransit || !origin || !queryTime || selectedMinutes.length === 0) {
      return null;
    }
    return {
      origin: { lng: origin[0], lat: origin[1] },
      queryTime,
      direction: "depart-at",
      thresholdsMinutes: [Math.max(...selectedMinutes)],
      walkProfileId: TRANSIT_WALK_PROFILE.id,
    };
  }, [isTransit, origin, queryTime, selectedMinutes, toolAnchored]);
  const surface = useTransitReachability(surfaceRequest, toolAnchored && isTransit);

  const destinations = useMemo(
    () =>
      (base.filtered ?? []).map((place) => ({
        id: place.id,
        lng: place.coordinates[0],
        lat: place.coordinates[1],
      })),
    [base.filtered],
  );
  const destinationCountSupported = destinations.length <= MAX_TRANSIT_REACHABILITY_DESTINATIONS;
  const exactAvailable = surface.data?.capabilities.exactPointChecks === true;
  const exactRequest = useMemo<TransitReachabilityCheckRequest | null>(() => {
    if (
      !filterRequested ||
      !isTransit ||
      !surfaceRequest ||
      !exactAvailable ||
      !destinationCountSupported ||
      destinations.length === 0
    ) {
      return null;
    }
    return { ...surfaceRequest, destinations };
  }, [
    destinationCountSupported,
    destinations,
    exactAvailable,
    filterRequested,
    isTransit,
    surfaceRequest,
  ]);
  const exact = useTransitReachabilityCheck(exactRequest, exactRequest !== null);
  const exactFiltered = useMemo(
    () => applyExactTransitReachability(base.filtered ?? [], exact.data),
    [base.filtered, exact.data],
  );

  useEffect(() => {
    if (!filterRequested || !isTransit) setTransitFilterState("off");
    else if (surface.isError) setTransitFilterState("failed");
    else if (!surface.data) setTransitFilterState("pending");
    else if (!exactAvailable || !destinationCountSupported) setTransitFilterState("unavailable");
    else if (destinations.length === 0) setTransitFilterState("applied");
    else if (exact.isError || (exact.data && exactFiltered === null)) {
      setTransitFilterState("failed");
    } else if (!exact.data || exact.isFetching) setTransitFilterState("pending");
    else setTransitFilterState("applied");
  }, [
    destinationCountSupported,
    destinations.length,
    exact.data,
    exact.isError,
    exact.isFetching,
    exactAvailable,
    exactFiltered,
    filterRequested,
    isTransit,
    setTransitFilterState,
    surface.data,
    surface.isError,
  ]);

  const filtered = useMemo(() => {
    if (!filterRequested || !base.filtered) return base.filtered;
    if (isTransit) return exactFiltered ?? base.filtered;
    const outer = isochroneData?.contours.reduce(
      (max, contour) => (max && max.time >= contour.time ? max : contour),
      isochroneData.contours[0],
    );
    if (!outer) return base.filtered;
    return base.filtered.filter((place) =>
      pointInIsochroneGeometry(place.coordinates, outer.geometry),
    );
  }, [base.filtered, exactFiltered, filterRequested, isTransit, isochroneData]);

  return { ...base, filtered, filterState: transitFilterState };
}
