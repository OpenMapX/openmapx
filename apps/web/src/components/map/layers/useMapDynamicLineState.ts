"use client";

import type * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useId, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { clearGroupError, reportGroupError } from "@/lib/map/mapLayerDiagnostics";

export interface DynamicLineState {
  /** Paint properties to set per layer: layerId -> { paintPropertyName -> value }. */
  paint?: Record<string, Record<string, unknown>>;
  /** Filters to set per layer: layerId -> filter expression. */
  filters?: Record<string, unknown>;
}

/** Widened signatures for the two setters this hook calls with dynamic names. */
type SetPaintProperty = (layerId: string, name: string, value: unknown) => void;
type SetFilter = (layerId: string, filter: maplibregl.FilterSpecification) => void;

/** Last value applied to a layer, tagged with the layer object it was applied to. */
interface AppliedPaint {
  layer: unknown;
  values: Map<string, unknown>;
}
interface AppliedFilter {
  layer: unknown;
  value: unknown;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Paint/filter values are expressions — fresh arrays/objects every render
  // even when unchanged — so fall back to structural comparison.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Apply progress-driven paint/filter values to layers `useMapLayerGroup`
 * already owns, without going through its descriptor.
 *
 * `useMapLayerGroup` removes and re-adds a layer whenever its serialized spec
 * changes — correct for structural change, catastrophic for high-frequency
 * updates: navigation progress updates several times a second, and
 * re-creating the route layer on every fix is exactly the waste this hook
 * exists to avoid. It only ever calls `setPaintProperty` / `setFilter` on
 * layers that already exist; it never creates or removes a source or a
 * layer, so it is safe to layer on top of a group without fighting it.
 *
 * Applies on every render, no dependency array — matching `useMapLayerGroup`'s
 * deliberate choice: a no-op pass here is a few map lookups and comparisons.
 * A value identical to the last one actually applied *to the layer object
 * currently on the map* is skipped, which is what makes 100 progress updates
 * that don't change the gradient cost zero MapLibre calls — and what makes a
 * post-rebuild reapply happen automatically: the recreated layer is a new
 * object, so the identity check treats every retained value as new again
 * without needing a separate "clear the cache" step.
 */
export function useMapDynamicLineState(state: DynamicLineState): void {
  const { mapRef, mapReady } = useMap();
  const key = useId();
  const stateRef = useRef(state);
  stateRef.current = state;
  const appliedPaintRef = useRef(new Map<string, AppliedPaint>());
  const appliedFilterRef = useRef(new Map<string, AppliedFilter>());

  const apply = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const desired = stateRef.current;
    try {
      for (const [layerId, props] of Object.entries(desired.paint ?? {})) {
        const layer = map.getLayer(layerId);
        // Not created yet — the group's effect may not have run yet. Leave the
        // retained value in `stateRef` alone so a later pass applies it.
        if (!layer) continue;

        let entry = appliedPaintRef.current.get(layerId);
        if (!entry || entry.layer !== layer) {
          entry = { layer, values: new Map() };
          appliedPaintRef.current.set(layerId, entry);
        }
        for (const [name, value] of Object.entries(props)) {
          if (entry.values.has(name) && sameValue(entry.values.get(name), value)) continue;
          (map.setPaintProperty as unknown as SetPaintProperty)(layerId, name, value);
          entry.values.set(name, value);
        }
      }

      for (const [layerId, filter] of Object.entries(desired.filters ?? {})) {
        const layer = map.getLayer(layerId);
        if (!layer) continue;

        const previous = appliedFilterRef.current.get(layerId);
        if (previous && previous.layer === layer && sameValue(previous.value, filter)) continue;
        (map.setFilter as unknown as SetFilter)(layerId, filter as maplibregl.FilterSpecification);
        appliedFilterRef.current.set(layerId, { layer, value: filter });
      }
    } catch (error) {
      // One bad layer id or malformed expression must not take the whole map
      // down — leave the applied caches as they were so a later pass retries.
      reportGroupError(key, error);
      return;
    }
    clearGroupError(key);
  }, [key, mapRef]);

  // No dependency array: `state` can change on every render (a GPS fix), and a
  // pass over unchanged values is cheap — see the doc comment above.
  useEffect(() => {
    if (!mapReady) return;
    apply();
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let disposed = false;
    let microtaskPending = false;
    // `setStyle` destroys every layer the app added; `useMapLayerGroup`
    // recreates them from a `style.load` listener that fires synchronously
    // inside `setStyle`. Listener ordering between the two hooks is not
    // guaranteed, so this subscribes to both `style.load` and `styledata` and
    // retries once more on a microtask, mirroring
    // `useGeoJsonSourceDataBridge`'s handling of the identical ordering
    // problem: if the group's layers land later in the same tick, this still
    // catches them.
    const rebuild = () => {
      if (disposed) return;
      apply();
      if (microtaskPending) return;
      microtaskPending = true;
      queueMicrotask(() => {
        microtaskPending = false;
        if (!disposed) apply();
      });
    };

    map.on("style.load", rebuild);
    map.on("styledata", rebuild);
    return () => {
      disposed = true;
      map.off("style.load", rebuild);
      map.off("styledata", rebuild);
    };
  }, [apply, mapReady, mapRef]);

  useEffect(() => {
    // Listeners only — the group's own teardown removes the layers, so there
    // is nothing here to restore.
    return () => {
      clearGroupError(key);
    };
  }, [key]);
}
