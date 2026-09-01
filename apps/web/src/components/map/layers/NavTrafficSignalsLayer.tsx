"use client";

import { useMemo } from "react";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useNavTrafficSignals } from "@/lib/navigation/useNavTrafficSignals";
import { loadTrafficLightImage, TRAFFIC_LIGHT_IMAGE_ID } from "@/lib/trafficLightMarker";

const SOURCE = "nav-traffic-signals-source";
export const NAV_TRAFFIC_SIGNALS_LAYER_ID = "nav-traffic-signals";

export function NavTrafficSignalsLayer() {
  const signals = useNavTrafficSignals();

  const data = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: signals.map((coord) => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: coord },
      })),
    }),
    [signals],
  );

  const group = useMemo<MapLayerGroup>(
    () => ({
      // Registering the icon is asynchronous, so it cannot be part of the
      // descriptor's data — a style change drops it along with everything else
      // and it lands a tick later, briefly rendering nothing.
      images: { [TRAFFIC_LIGHT_IMAGE_ID]: loadTrafficLightImage },
      sources: { [SOURCE]: { type: "geojson", data } },
      layers: [
        {
          id: NAV_TRAFFIC_SIGNALS_LAYER_ID,
          type: "symbol",
          source: SOURCE,
          layout: {
            "icon-image": TRAFFIC_LIGHT_IMAGE_ID,
            "icon-size": 0.8,
            "icon-allow-overlap": true,
            "icon-anchor": "center",
          },
          slot: "nav-top",
          order: 0,
        },
      ] satisfies SlottedLayer[],
    }),
    [data],
  );
  useMapLayerGroup(group);

  return null;
}
