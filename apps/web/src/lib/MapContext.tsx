"use client";

import type maplibregl from "maplibre-gl";
import { createContext, useCallback, useContext, useRef } from "react";

interface MapContextValue {
  mapRef: React.RefObject<maplibregl.Map | null>;
  flyTo: (center: [number, number], zoom?: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetBearing: () => void;
}

const MapContext = createContext<MapContextValue | null>(null);

export function MapProvider({ children }: { children: React.ReactNode }) {
  const mapRef = useRef<maplibregl.Map | null>(null);

  const flyTo = useCallback((center: [number, number], zoom?: number) => {
    mapRef.current?.flyTo({ center, zoom, duration: 1500 });
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
    <MapContext.Provider value={{ mapRef, flyTo, zoomIn, zoomOut, resetBearing }}>
      {children}
    </MapContext.Provider>
  );
}

export function useMap(): MapContextValue {
  const ctx = useContext(MapContext);
  if (!ctx) throw new Error("useMap must be used within <MapProvider>");
  return ctx;
}
