"use client";

import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { useNavTrafficSignals } from "@/lib/navigation/useNavTrafficSignals";
import { loadTrafficLightImage, TRAFFIC_LIGHT_IMAGE_ID } from "@/lib/trafficLightMarker";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE = "nav-traffic-signals-source";
export const NAV_TRAFFIC_SIGNALS_LAYER_ID = "nav-traffic-signals";
const LAYER = NAV_TRAFFIC_SIGNALS_LAYER_ID;

interface LayerOrderMap {
  getLayer(id: string): unknown;
  moveLayer(id: string, beforeId?: string): unknown;
}

/**
 * Keep the traffic-light symbols above the blue route line. Without this the
 * layer's stacking is decided by whichever create-effect (route vs. signals)
 * ran last, so the icons intermittently rendered beneath the route. Re-asserting
 * the order after each create and data update makes it deterministic across
 * style swaps. The user-location puck is a DOM marker, so moving to the top of
 * the canvas layers never covers it.
 */
export function orderNavTrafficSignalsLayer(map: LayerOrderMap): void {
  if (map.getLayer(LAYER)) map.moveLayer(LAYER);
}

export function NavTrafficSignalsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const signals = useNavTrafficSignals();

  // Create source + symbol layer once per style.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    loadTrafficLightImage(map);
    if (map.getSource(SOURCE)) return;

    map.addSource(SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: LAYER,
      type: "symbol",
      source: SOURCE,
      layout: {
        "icon-image": TRAFFIC_LIGHT_IMAGE_ID,
        "icon-size": 0.8,
        "icon-allow-overlap": true,
        "icon-anchor": "center",
      },
    });
    orderNavTrafficSignalsLayer(map);
  }, [mapRef, mapReady, styleVersion]);

  // Push signal points into the source. `styleVersion` is a required dep, not
  // redundant work: a full style swap (basemap / theme / satellite) wipes the
  // source, so the icons must be re-pushed once the create-effect re-adds it.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map) return;
    const raw = map.getSource(SOURCE);
    if (raw?.type !== "geojson") return;
    const source = raw as GeoJSONSource;
    source.setData({
      type: "FeatureCollection",
      features: signals.map((coord) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: coord },
      })),
    });
    orderNavTrafficSignalsLayer(map);
  }, [mapRef, signals, styleVersion]);

  return null;
}
