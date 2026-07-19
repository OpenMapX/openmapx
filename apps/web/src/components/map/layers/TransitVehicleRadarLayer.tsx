"use client";

import { type BBox, useNavigationStore, useTransitVehicleRadar } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useMemo, useState } from "react";
import { useMap } from "@/lib/MapContext";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE = "transit-vehicle-radar-source";
const DOT_LAYER = "transit-vehicle-radar-dots";
const LABEL_LAYER = "transit-vehicle-radar-labels";
// Below this zoom a viewport can hold thousands of vehicles — don't fetch.
const MIN_ZOOM = 11;

// Vehicle dot colour by transport mode.
const MODE_COLOR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "mode"],
  "rail",
  "#6a1b9a",
  "subway",
  "#1565c0",
  "tram",
  "#00838f",
  "bus",
  "#e65100",
  "ferry",
  "#0277bd",
  "#455a64",
];

/**
 * Live transit vehicles in the current viewport during transit navigation
 * (MOTIS `map/trips`). Vehicles on the traveller's own itinerary are ringed so
 * the bus/train they're on — and the connection they're heading for — stand out
 * from surrounding traffic. Disabled when not navigating transit or zoomed out.
 */
export function TransitVehicleRadarLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const itinerary = useNavigationStore((s) => s.itinerary);
  const active = status === "navigating" && kind === "transit";

  const [bbox, setBbox] = useState<BBox | null>(null);

  // Track the viewport (throttled to move end) while active, so the radar query
  // key follows the map. Clear it when navigation stops.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !active) {
      setBbox(null);
      return;
    }
    const update = () => {
      if (map.getZoom() < MIN_ZOOM) {
        setBbox(null);
        return;
      }
      const b = map.getBounds();
      setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    update();
    map.on("moveend", update);
    return () => {
      map.off("moveend", update);
    };
  }, [mapRef, mapReady, active]);

  const { data: vehicles } = useTransitVehicleRadar(bbox);

  const activeTripIds = useMemo(
    () => new Set((itinerary?.legs ?? []).map((l) => l.tripId).filter(Boolean)),
    [itinerary],
  );

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const cleanup = () => {
      if (map.getLayer(LABEL_LAYER)) map.removeLayer(LABEL_LAYER);
      if (map.getLayer(DOT_LAYER)) map.removeLayer(DOT_LAYER);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    };

    if (!active || !vehicles?.length) {
      cleanup();
      return;
    }

    const geojson = {
      type: "FeatureCollection" as const,
      features: vehicles.map((v) => ({
        type: "Feature" as const,
        properties: {
          label: v.label ?? "",
          mode: v.mode ?? "",
          onRoute: v.tripId && activeTripIds.has(v.tripId) ? 1 : 0,
        },
        geometry: { type: "Point" as const, coordinates: [v.lng, v.lat] },
      })),
    };

    const source = map.getSource(SOURCE);
    if (source?.type === "geojson") {
      (source as GeoJSONSource).setData(geojson);
      return;
    }

    map.addSource(SOURCE, { type: "geojson", data: geojson });
    map.addLayer({
      id: DOT_LAYER,
      type: "circle",
      source: SOURCE,
      paint: {
        "circle-radius": ["case", ["==", ["get", "onRoute"], 1], 7, 5],
        "circle-color": MODE_COLOR,
        "circle-stroke-width": ["case", ["==", ["get", "onRoute"], 1], 3, 1.5],
        "circle-stroke-color": ["case", ["==", ["get", "onRoute"], 1], "#000", "#fff"],
        "circle-opacity": 0.95,
      },
    });
    map.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SOURCE,
      minzoom: 13,
      layout: {
        "text-field": ["get", "label"],
        "text-size": 10,
        "text-offset": [0, -1.2],
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#111",
        "text-halo-color": "#fff",
        "text-halo-width": 1.2,
      },
    });

    return cleanup;
  }, [mapRef, mapReady, styleVersion, active, vehicles, activeTripIds]);

  return null;
}
