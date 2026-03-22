"use client";

import { MODE_COLORS, usePlaceStore, useRouteLive, useTransitRoute } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";

const SOURCE_ID = "vehicle-live-source";
const LAYER_ID = "vehicle-live-layer";

export function VehicleLiveLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const activeRouteId = usePlaceStore((s) => s.activeRouteId);
  const { data: liveData } = useRouteLive(activeRouteId);
  const { data: route } = useTransitRoute(activeRouteId);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const cleanup = () => {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };

    if (!activeRouteId || !liveData?.vehicles.length) {
      cleanup();
      return;
    }

    const lineColor = route?.color
      ? `#${route.color.replace("#", "")}`
      : route?.mode
        ? MODE_COLORS[route.mode]
        : PRIMARY_BLUE_HEX;

    const geojson = {
      type: "FeatureCollection" as const,
      features: liveData.vehicles.map((v) => ({
        type: "Feature" as const,
        properties: {
          id: v.id,
          label: v.label ?? "",
        },
        geometry: { type: "Point" as const, coordinates: [v.lng, v.lat] },
      })),
    };

    cleanup();

    map.addSource(SOURCE_ID, { type: "geojson", data: geojson });

    // Vehicle dot
    map.addLayer({
      id: LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-radius": 10,
        "circle-color": lineColor,
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#fff",
        "circle-opacity": 0.95,
      },
    });

    return cleanup;
  }, [mapRef, mapReady, styleVersion, activeRouteId, liveData, route]);

  return null;
}
