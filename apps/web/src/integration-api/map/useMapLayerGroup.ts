"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import { clearDesired, recordDesired } from "@/components/map/layers/desiredStack";
import { useMap } from "@/integration-api/map/MapContext";
import { clearGroupError, reportGroupError } from "@/lib/map/mapLayerDiagnostics";
import { type AppliedGroup, applyGroup, emptyApplied, type MapLayerGroup } from "./mapLayerGroup";

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

  // One bad descriptor must not take the map down with it. Without this, a spec
  // naming a source the group does not declare throws out of a React effect,
  // which unmounts the whole tree — every other layer included — rather than
  // leaving one layer blank.
  const apply = useCallback(
    (from: AppliedGroup) => {
      const map = mapRef.current;
      if (!map) return;
      try {
        appliedRef.current = applyGroup(map, groupRef.current, from);
      } catch (error) {
        // Keep the previous applied state: it still describes what is on the
        // map, so the next pass reconciles from something true rather than from
        // a half-applied guess.
        reportGroupError(key, error);
        return;
      }
      clearGroupError(key);
      recordDesired(key, {
        sourceIds: appliedRef.current.sourceIds,
        layerIds: appliedRef.current.layerIds,
      });
    },
    [key, mapRef],
  );

  // No dependency array: the descriptor can change on any render, and a pass over
  // an unchanged one is a few map lookups and reference comparisons.
  useEffect(() => {
    if (!mapReady) return;
    apply(appliedRef.current);
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Everything this group put on the map is gone, so nothing is "already
    // applied" — a full recreate from the latest descriptor is the only correct
    // starting point.
    const rebuild = () => apply(emptyApplied());

    map.on("style.load", rebuild);
    return () => {
      map.off("style.load", rebuild);
    };
  }, [apply, mapRef, mapReady]);

  useEffect(() => {
    return () => {
      // Deregister first, and unconditionally. `MapCanvas` nulls the shared ref
      // in its own cleanup, and it is a sibling of the layers rather than their
      // parent — so when the tree comes down it can run first and leave every
      // layer unmounting with no map. Skipping this on that path would strand
      // the entry, and the next map instance would report it as wrongly missing.
      clearDesired(key);
      clearGroupError(key);
      const map = mapRef.current;
      if (!map) return;
      appliedRef.current = applyGroup(map, null, appliedRef.current);
    };
  }, [key, mapRef]);
}
