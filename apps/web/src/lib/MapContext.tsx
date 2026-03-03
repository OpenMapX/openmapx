"use client";

import type maplibregl from "maplibre-gl";
import { createContext, useCallback, useContext, useRef, useState } from "react";

interface MapContextValue {
  mapRef: React.RefObject<maplibregl.Map | null>;
  mapReady: boolean;
  notifyMapReady: () => void;
  flyTo: (center: [number, number], zoom?: number) => void;
  fitBounds: (bounds: [[number, number], [number, number]], padding?: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetBearing: () => void;
}

const MapContext = createContext<MapContextValue | null>(null);

export function MapProvider({ children }: { children: React.ReactNode }) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const pendingFlyTo = useRef<{ center: [number, number]; zoom?: number } | null>(null);

  const notifyMapReady = useCallback(() => {
    const pending = pendingFlyTo.current;
    if (pending && mapRef.current) {
      // Use jumpTo (instant) for queued calls — no animation racing with map init
      mapRef.current.jumpTo({ center: pending.center, zoom: pending.zoom ?? 15 });
      pendingFlyTo.current = null;
    }
    setMapReady(true);
  }, []);

  const flyTo = useCallback((center: [number, number], zoom?: number) => {
    if (mapRef.current) {
      mapRef.current.flyTo({ center, zoom, duration: 1500 });
    } else {
      // Map not ready yet — queue for when notifyMapReady fires
      pendingFlyTo.current = { center, zoom };
    }
  }, []);

  const fitBounds = useCallback((bounds: [[number, number], [number, number]], padding = 80) => {
    mapRef.current?.fitBounds(bounds, { padding, duration: 1000 });
  }, []);

  const zoomIn = useCallback(() => {
    mapRef.current?.zoomIn({ duration: 200 });
  }, []);

  const zoomOut = useCallback(() => {
    mapRef.current?.zoomOut({ duration: 200 });
  }, []);

  const resetBearing = useCallback(() => {
    mapRef.current?.easeTo({ bearing: 0, pitch: 0, duration: 300 });
  }, []);

  return (
    <MapContext.Provider
      value={{ mapRef, mapReady, notifyMapReady, flyTo, fitBounds, zoomIn, zoomOut, resetBearing }}
    >
      {children}
    </MapContext.Provider>
  );
}

export function useMap(): MapContextValue {
  const ctx = useContext(MapContext);
  if (!ctx) throw new Error("useMap must be used within <MapProvider>");
  return ctx;
}
