"use client";

import { useEffect, useId, useRef } from "react";
import { useMap } from "@/lib/MapContext";
import { clearDesired, recordDesired } from "./desiredStack";
import { applyGroup, emptyApplied, type MapLayerGroup } from "./mapLayerGroup";

/**
 * Draw a group of sources and layers, and keep drawing it across style changes.
 *
 * `setStyle` — a dark/light swap, a basemap switch, a satellite toggle — destroys
 * every source and layer the app added. MapLibre fires `style.load` synchronously
 * inside that call, so rebuilding from a listener here puts everything back before
 * `setStyle` returns: no blank frame, and no dependency on a React render landing
 * in time. Gating on `isStyleLoaded()` would be wrong — it also waits for every
 * tile and image, while adding sources and layers only needs the style parsed.
 *
 * Returns nothing, deliberately. The predecessor to this hook returned a counter
 * so a separate effect could push data once the sources were recreated; that split
 * is exactly how a rebuilt layer ends up with empty sources and draws nothing. Put
 * the data in the descriptor instead.
 *
 * @param group what to draw, or `null` to draw nothing
 */
export function useMapLayerGroup(group: MapLayerGroup | null): void {
  const { mapRef, mapReady } = useMap();
  const key = useId();
  const groupRef = useRef(group);
  groupRef.current = group;
  const appliedRef = useRef(emptyApplied());

  // No dependency array: the descriptor can change on any render, and a pass over
  // an unchanged one is a few map lookups and reference comparisons.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    appliedRef.current = applyGroup(map, groupRef.current, appliedRef.current);
    recordDesired(key, {
      sourceIds: appliedRef.current.sourceIds,
      layerIds: appliedRef.current.layerIds,
    });
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const rebuild = () => {
      // Everything this group put on the map is gone, so nothing is "already
      // applied" — a full recreate from the latest descriptor is the only correct
      // starting point.
      appliedRef.current = applyGroup(map, groupRef.current, emptyApplied());
      recordDesired(key, {
        sourceIds: appliedRef.current.sourceIds,
        layerIds: appliedRef.current.layerIds,
      });
    };

    map.on("style.load", rebuild);
    return () => {
      map.off("style.load", rebuild);
    };
  }, [key, mapRef, mapReady]);

  useEffect(() => {
    return () => {
      const map = mapRef.current;
      if (!map) return;
      appliedRef.current = applyGroup(map, null, appliedRef.current);
      clearDesired(key);
    };
  }, [key, mapRef]);
}
