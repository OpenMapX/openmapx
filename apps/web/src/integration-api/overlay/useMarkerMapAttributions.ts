"use client";

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { useMemo } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { markerMapContributors } from "./markerMapContribution";
import { useRenderedMapAttributions } from "./useRenderedMapAttributions";

const NO_LAYERS: readonly string[] = [];

/** Uses the shared render scheduler; no extra feature queries for DOM markers. */
export function useMarkerMapAttributions(
  key: string,
  element: Element | null,
  contributors: readonly Attribution[],
  channel: "geometry" | "text" = "geometry",
): void {
  const { mapRef } = useMap();
  const map = mapRef.current;
  const captured = useMemo(() => snapshotContributors(contributors), [contributors]);
  useRenderedMapAttributions(key, NO_LAYERS, element !== null, {
    resolveCustomContributors: () =>
      map ? markerMapContributors(map.getContainer(), element, captured, channel) : [],
  });
}
