"use client";

import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { useNavTrafficSignals } from "@/lib/navigation/useNavTrafficSignals";
import { loadTrafficLightImage, TRAFFIC_LIGHT_IMAGE_ID } from "@/lib/trafficLightMarker";
import { addLayerInSlot } from "./layerStack";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE = "nav-traffic-signals-source";
export const NAV_TRAFFIC_SIGNALS_LAYER_ID = "nav-traffic-signals";
const LAYER = NAV_TRAFFIC_SIGNALS_LAYER_ID;

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
    addLayerInSlot(
      map,
      {
        id: LAYER,
        type: "symbol",
        source: SOURCE,
        layout: {
          "icon-image": TRAFFIC_LIGHT_IMAGE_ID,
          "icon-size": 0.8,
          "icon-allow-overlap": true,
          "icon-anchor": "center",
        },
      },
      "nav-top",
      0,
    );
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
  }, [mapRef, signals, styleVersion]);

  return null;
}
