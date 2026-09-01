"use client";

import type { LngLat } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import {
  DEFAULT_INNER_PADDING,
  type InnerPadding,
  issueCameraRequest,
  type MapBounds,
  toInsets,
} from "@/lib/cameraFraming";
import { getCameraPaddingTarget } from "@/lib/cameraPadding";
import { prefersReducedMotion } from "@/lib/reducedMotion";

const FLY_MS = 1500;
const FIT_MS = 1000;

export interface FitBoundsOptions {
  duration?: number;
  maxZoom?: number;
}

export interface MapContextValue {
  mapRef: React.RefObject<maplibregl.Map | null>;
  mapReady: boolean;
  /** Increments on each style.load — layer components should include this in effect deps to re-attach after style swap. */
  styleVersion: number;
  notifyMapReady: () => void;
  notifyStyleReload: () => void;
  flyTo: (center: LngLat, zoom?: number, motion?: { duration?: number }) => void;
  /**
   * Frames `bounds` in the visible viewport. `padding` is breathing room inside
   * the visible area; panels, sheets, and navigation chrome are accounted for
   * automatically.
   */
  fitBounds: (bounds: MapBounds, padding?: InnerPadding, options?: FitBoundsOptions) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetBearing: () => void;
}

const MapContext = createContext<MapContextValue | null>(null);

export function MapProvider({ children }: { children: React.ReactNode }) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const pendingFlyTo = useRef<{ center: LngLat; zoom?: number } | null>(null);

  const notifyMapReady = useCallback(() => {
    const pending = pendingFlyTo.current;
    const map = mapRef.current;
    if (pending && map) {
      issueCameraRequest(map, {
        kind: "flyTo",
        center: pending.center,
        zoom: pending.zoom ?? 15,
        duration: 0,
        startedAt: performance.now(),
        padding: getCameraPaddingTarget(map),
      });
      pendingFlyTo.current = null;
    }
    setMapReady(true);
  }, []);

  const notifyStyleReload = useCallback(() => {
    setStyleVersion((v) => v + 1);
  }, []);

  const flyTo = useCallback((center: LngLat, zoom?: number, motion?: { duration?: number }) => {
    const map = mapRef.current;
    if (!map) {
      pendingFlyTo.current = { center, zoom };
      return;
    }
    issueCameraRequest(map, {
      kind: "flyTo",
      center,
      zoom,
      duration: prefersReducedMotion() ? 0 : (motion?.duration ?? FLY_MS),
      startedAt: performance.now(),
      padding: getCameraPaddingTarget(map),
    });
  }, []);

  const fitBounds = useCallback(
    (bounds: MapBounds, padding?: InnerPadding, options?: FitBoundsOptions) => {
      const map = mapRef.current;
      if (!map) return;
      issueCameraRequest(map, {
        kind: "fitBounds",
        bounds,
        inner: toInsets(padding, DEFAULT_INNER_PADDING),
        maxZoom: options?.maxZoom,
        duration: prefersReducedMotion() ? 0 : (options?.duration ?? FIT_MS),
        startedAt: performance.now(),
        padding: getCameraPaddingTarget(map),
      });
    },
    [],
  );

  const zoomIn = useCallback(() => {
    mapRef.current?.zoomIn({ duration: 200 });
  }, []);

  const zoomOut = useCallback(() => {
    mapRef.current?.zoomOut({ duration: 200 });
  }, []);

  const resetBearing = useCallback(() => {
    mapRef.current?.easeTo(
      { bearing: 0, pitch: 0, duration: prefersReducedMotion() ? 0 : 300 },
      { programmatic: true },
    );
  }, []);

  const value = useMemo<MapContextValue>(
    () => ({
      mapRef,
      mapReady,
      styleVersion,
      notifyMapReady,
      notifyStyleReload,
      flyTo,
      fitBounds,
      zoomIn,
      zoomOut,
      resetBearing,
    }),
    [
      mapReady,
      styleVersion,
      notifyMapReady,
      notifyStyleReload,
      flyTo,
      fitBounds,
      zoomIn,
      zoomOut,
      resetBearing,
    ],
  );

  return <MapContext.Provider value={value}>{children}</MapContext.Provider>;
}

export function useMap(): MapContextValue {
  const ctx = useContext(MapContext);
  if (!ctx) throw new Error("useMap must be used within <MapProvider>");
  return ctx;
}

/** Returns the map context if available, or `null` outside `<MapProvider>`. */
export function useMapOptional(): MapContextValue | null {
  return useContext(MapContext);
}

export type { InnerPadding, MapBounds };
