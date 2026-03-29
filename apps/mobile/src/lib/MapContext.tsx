import type { CameraRef, MapRef } from "@maplibre/maplibre-react-native";
import { createContext, useCallback, useContext, useRef, useState } from "react";

interface MapContextValue {
  mapRef: React.RefObject<MapRef | null>;
  cameraRef: React.RefObject<CameraRef | null>;
  mapReady: boolean;
  styleVersion: number;
  notifyMapReady: () => void;
  notifyStyleReload: () => void;
  flyTo: (center: [number, number], zoom?: number) => void;
  fitBounds: (bounds: [number, number, number, number], padding?: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetBearing: () => void;
}

const MapContext = createContext<MapContextValue | null>(null);

export function MapProvider({ children }: { children: React.ReactNode }) {
  const mapRef = useRef<MapRef | null>(null);
  const cameraRef = useRef<CameraRef | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const pendingFlyTo = useRef<{
    center: [number, number];
    zoom?: number;
  } | null>(null);

  const notifyMapReady = useCallback(() => {
    const pending = pendingFlyTo.current;
    if (pending && cameraRef.current) {
      cameraRef.current.flyTo({
        center: pending.center,
        zoom: pending.zoom,
        duration: 1500,
      });
      pendingFlyTo.current = null;
    }
    setMapReady(true);
  }, []);

  const notifyStyleReload = useCallback(() => {
    setStyleVersion((v) => v + 1);
  }, []);

  const flyTo = useCallback((center: [number, number], zoom?: number) => {
    if (cameraRef.current) {
      cameraRef.current.flyTo({ center, zoom, duration: 1500 });
    } else {
      pendingFlyTo.current = { center, zoom };
    }
  }, []);

  const fitBounds = useCallback((bounds: [number, number, number, number], padding = 80) => {
    cameraRef.current?.fitBounds(bounds, {
      padding: { top: padding, right: padding, bottom: padding, left: padding },
      duration: 1000,
    });
  }, []);

  const zoomIn = useCallback(async () => {
    const zoom = await mapRef.current?.getZoom();
    if (zoom !== undefined) {
      cameraRef.current?.zoomTo(zoom + 1, { duration: 200 });
    }
  }, []);

  const zoomOut = useCallback(async () => {
    const zoom = await mapRef.current?.getZoom();
    if (zoom !== undefined) {
      cameraRef.current?.zoomTo(zoom - 1, { duration: 200 });
    }
  }, []);

  const resetBearing = useCallback(async () => {
    const center = await mapRef.current?.getCenter();
    if (center) {
      cameraRef.current?.easeTo({
        center: center as [number, number],
        bearing: 0,
        pitch: 0,
        duration: 300,
      });
    }
  }, []);

  return (
    <MapContext.Provider
      value={{
        mapRef,
        cameraRef,
        mapReady,
        styleVersion,
        notifyMapReady,
        notifyStyleReload,
        flyTo,
        fitBounds,
        zoomIn,
        zoomOut,
        resetBearing,
      }}
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
