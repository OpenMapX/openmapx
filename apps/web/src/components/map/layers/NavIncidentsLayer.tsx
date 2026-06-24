"use client";

import { useSettingsStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { useNavIncidents } from "@/lib/navigation/useNavIncidents";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE = "nav-incidents-source";
const LAYER = "nav-incidents";

const SEVERITY_COLOR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "severity"],
  "critical",
  "#7e0023",
  "high",
  "#cc0033",
  "medium",
  "#ff9933",
  "low",
  "#ffde33",
  "#8a8a8a",
];

/**
 * Renders the route-corridor traffic incidents on the navigation map, styled by
 * severity so they read in the nav camera. Mirrors NavTrafficSignalsLayer's
 * GeoJSON-source + style-synced add/update pattern.
 */
export function NavIncidentsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { incidents } = useNavIncidents();
  const incidentAlerts = useSettingsStore((s) => s.incidentAlerts);
  // Only render markers when the user has incident display enabled; the fetch
  // may still be running for avoidIncidents, but markers stay hidden.
  const visibleIncidents = incidentAlerts ? incidents : [];

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (map.getSource(SOURCE)) return;

    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: LAYER,
      type: "circle",
      source: SOURCE,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 16, 10],
        "circle-color": SEVERITY_COLOR,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
        "circle-opacity": 0.9,
      },
    });
  }, [mapRef, mapReady, styleVersion]);

  // styleVersion is a required dep: a full style swap wipes the source, so the
  // incidents must be re-pushed once the create-effect re-adds it.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE);
    if (raw?.type !== "geojson") return;
    (raw as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: visibleIncidents.map((i) => ({
        type: "Feature",
        properties: { severity: i.severity, eventType: i.eventType },
        geometry: { type: "Point", coordinates: i.coord },
      })),
    });
  }, [mapRef, visibleIncidents, styleVersion]);

  return null;
}
