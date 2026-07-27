"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { type Capabilities, GIBS_LAYERS, useSatelliteStore } from "./store";

const SOURCE_ID = "openmapx-satellite-gibs-source";
const LAYER_ID = "openmapx-satellite-gibs-layer";

function getLayerDef(id: string) {
  return GIBS_LAYERS.find((l) => l.id === id) ?? GIBS_LAYERS[0];
}

export function SatelliteLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useSatelliteStore((s) => s.layerVisible);
  useIntegrationAttribution("overlay-satellite", layerVisible);
  const activeLayer = useSatelliteStore((s) => s.activeLayer);
  const date = useSatelliteStore((s) => s.date);
  const opacity = useSatelliteStore((s) => s.opacity);
  const capabilities = useSatelliteStore((s) => s.capabilities);

  const setDate = useSatelliteStore((s) => s.setDate);
  const setCapabilities = useSatelliteStore((s) => s.setCapabilities);

  useOverlayExclusion("satellite", layerVisible);
  useLayerReanchor(LAYER_ID, layerVisible);

  const prevKeyRef = useRef("");
  const fetchedRef = useRef(false);

  // Fetch WMTS capabilities (date ranges per layer)
  const fetchCapabilities = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    try {
      const res = await fetch(`${env.apiUrl}/api/integrations/overlay-satellite/capabilities`);
      if (!res.ok) return;
      const data = (await res.json()) as Capabilities;
      setCapabilities(data);

      // Auto-adjust date to the latest available for the active layer
      const layerCap = data[useSatelliteStore.getState().activeLayer];
      if (layerCap) {
        const currentDate = useSatelliteStore.getState().date;
        if (currentDate > layerCap.defaultDate) {
          setDate(layerCap.defaultDate);
        }
      }
    } catch {
      // silent — capabilities unavailable, keep defaults
    }
  }, [env.apiUrl, setCapabilities, setDate]);

  useEffect(() => {
    if (!layerVisible) {
      fetchedRef.current = false;
      return;
    }
    fetchCapabilities();
  }, [layerVisible, fetchCapabilities]);

  // Clamp date when active layer changes
  useEffect(() => {
    if (!capabilities) return;
    const layerCap = capabilities[activeLayer];
    if (!layerCap) return;

    const currentDate = useSatelliteStore.getState().date;
    if (currentDate > layerCap.defaultDate) {
      setDate(layerCap.defaultDate);
    } else if (currentDate < layerCap.startDate) {
      setDate(layerCap.startDate);
    }
  }, [activeLayer, capabilities, setDate]);

  // Manage map source + layer
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (!layerVisible) {
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // ignore
      }
      prevKeyRef.current = "";
      return;
    }

    const def = getLayerDef(activeLayer);
    const tileUrl = `${env.apiUrl}/api/integrations/overlay-satellite/tiles/${def.id}/${date}/{z}/{y}/{x}`;
    const key = `${def.id}:${date}`;

    // Fast path: date changed but same layer and source already exists.
    // Must run BEFORE isStyleLoaded() because that returns false while the
    // source's initial tiles are still loading — which is exactly the case
    // when capabilities auto-adjusts the date on mount.
    const existing = map.getSource(SOURCE_ID);
    if (prevKeyRef.current !== key && existing) {
      const prevLayerId = prevKeyRef.current ? prevKeyRef.current.split(":")[0] : "";
      if (prevLayerId === def.id) {
        prevKeyRef.current = key;
        // The source is the raster source added below; `setTiles` lives on
        // RasterTileSource, not the Source base type.
        (existing as maplibregl.RasterTileSource).setTiles([tileUrl]);
        map.triggerRepaint();
      }
    }

    const buildLayer = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", buildLayer);
        return;
      }

      // Handle key change requiring full rebuild (layer definition changed, different maxZoom)
      if (prevKeyRef.current !== key) {
        const prevLayerId = prevKeyRef.current ? prevKeyRef.current.split(":")[0] : "";
        prevKeyRef.current = key;
        if (prevLayerId && prevLayerId !== def.id) {
          try {
            if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
            if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
          } catch {
            // ignore
          }
        }
      }

      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: "raster",
          tiles: [tileUrl],
          tileSize: 256,
          maxzoom: def.maxZoom,
        });
      }

      if (!map.getLayer(LAYER_ID)) {
        map.addLayer(
          {
            id: LAYER_ID,
            type: "raster",
            source: SOURCE_ID,
            paint: { "raster-opacity": opacity, "raster-fade-duration": 0 },
          },
          getFirstSymbolLayerId(map),
        );
        map.triggerRepaint();
      }
    };

    buildLayer();

    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };

    function syncLayer() {
      if (!map?.isStyleLoaded()) return;
      if (!map.getSource(SOURCE_ID)) {
        prevKeyRef.current = "";
      }
    }
  }, [mapReady, styleVersion, mapRef, layerVisible, activeLayer, date, opacity, env.apiUrl]);

  // Update opacity without rebuilding source
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;
    if (map.getLayer(LAYER_ID)) {
      map.setPaintProperty(LAYER_ID, "raster-opacity", opacity);
    }
  }, [mapRef, mapReady, layerVisible, opacity]);

  return null;
}
