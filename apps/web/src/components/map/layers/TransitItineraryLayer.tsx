"use client";

import {
  API_ENDPOINTS,
  apiClient,
  MODE_COLORS,
  routeColor,
  useDirectionsStore,
  useNavigationStore,
} from "@openmapx/core";
import type { GeoJSONLineString, TransportMode } from "@openmapx/mobility-core/transit";
import type { ExpressionSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";

// Non-transit "street" legs (walk plus intermodal bike/car access) render as
// dashed lines — like the panel's street-leg styling — vs solid transit lines.
const STREET_MODES = new Set<TransportMode>(["walking", "cycling", "driving"]);

const SOURCE_ID = "transit-itinerary-source";
const WALK_LAYER_ID = "transit-itinerary-walk";
const TRANSIT_LAYER_ID = "transit-itinerary-transit";
const POINTS_SOURCE_ID = "transit-itinerary-points-source";
const POINTS_LAYER_ID = "transit-itinerary-points";

export function TransitItineraryLayer() {
  const { mapRef, mapReady, styleVersion, fitBounds } = useMap();
  const { mode, transitItineraries, activeItineraryIndex } = useDirectionsStore();

  // During transit follow-along navigation, dim every leg except the one the
  // traveller is currently on so the active segment stands out. When not
  // navigating, all legs render at full opacity (normal itinerary preview).
  const navActive = useNavigationStore(
    (s) => s.status !== "idle" && s.status !== "arrived" && s.kind === "transit",
  );
  const navLegIndex = useNavigationStore((s) => s.transitProgress?.currentLegIndex ?? 0);

  // Refined per-leg geometries fetched lazily from /leg-geometry after the
  // itinerary is selected. Keyed by tripId; replaces stopovers geometry when available.
  const [legGeometries, setLegGeometries] = useState<Record<string, GeoJSONLineString>>({});
  // Track the fetch generation so stale responses from a previous itinerary are discarded.
  const fetchGenRef = useRef(0);
  // Track which (itinerary list, index) pair has already had bounds fitted.
  // Keying on the list reference catches new searches that reset the index back
  // to 0, which a bare index comparison would miss.
  const fittedRef = useRef<{ list: typeof transitItineraries; index: number } | null>(null);

  useEffect(() => {
    if (mode !== "transit") {
      setLegGeometries({});
      return;
    }
    const itinerary = transitItineraries[activeItineraryIndex];
    if (!itinerary) return;

    const gen = ++fetchGenRef.current;
    setLegGeometries({});

    const transitLegs = itinerary.legs.filter((leg) => leg.tripId && leg.mode !== "walking");
    if (transitLegs.length === 0) return;

    void Promise.allSettled(
      transitLegs.map(async (leg) => {
        if (!leg.tripId) return;
        const { tripId } = leg;
        try {
          const params: Record<string, string> = { trip_id: tripId };
          if (leg.from.stopId) params.from_stop_id = leg.from.stopId;
          if (leg.to.stopId) params.to_stop_id = leg.to.stopId;
          const geo = await apiClient.get<GeoJSONLineString>(
            API_ENDPOINTS.transitLegGeometry,
            params,
          );
          if (fetchGenRef.current === gen && geo?.coordinates?.length >= 2) {
            setLegGeometries((prev) => ({ ...prev, [tripId]: geo }));
          }
        } catch {
          // geometry not available for this leg — stopovers geometry is used
        }
      }),
    );
  }, [mode, transitItineraries, activeItineraryIndex]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const cleanup = () => {
      if (map.getLayer(POINTS_LAYER_ID)) map.removeLayer(POINTS_LAYER_ID);
      if (map.getLayer(TRANSIT_LAYER_ID)) map.removeLayer(TRANSIT_LAYER_ID);
      if (map.getLayer(WALK_LAYER_ID)) map.removeLayer(WALK_LAYER_ID);
      if (map.getSource(POINTS_SOURCE_ID)) map.removeSource(POINTS_SOURCE_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };

    const isTransit = mode === "transit";
    const itinerary = isTransit ? transitItineraries[activeItineraryIndex] : null;

    if (!isTransit || !itinerary || itinerary.legs.length === 0) {
      cleanup();
      return;
    }

    cleanup();

    // When following a transit trip, dim non-current legs; otherwise full opacity.
    const lineOpacity: ExpressionSpecification | number = navActive
      ? ["case", ["==", ["get", "index"], navLegIndex], 1, 0.3]
      : 1;

    // Build line features for each leg; use refined trip geometry when available
    const lineFeatures = itinerary.legs.map((leg, i) => {
      const isStreet = STREET_MODES.has(leg.mode);
      const color = isStreet
        ? (MODE_COLORS[leg.mode] ?? "#757575")
        : routeColor({ color: leg.route?.color, mode: leg.mode }, PRIMARY_BLUE_HEX);
      const geometry = (leg.tripId ? legGeometries[leg.tripId] : undefined) ?? leg.geometry;

      return {
        type: "Feature" as const,
        properties: { isStreet, color, index: i },
        geometry,
      };
    });

    // Build transfer point features
    const pointFeatures: Array<{
      type: "Feature";
      properties: { name: string };
      geometry: { type: "Point"; coordinates: [number, number] };
    }> = [];

    for (const leg of itinerary.legs) {
      pointFeatures.push({
        type: "Feature",
        properties: { name: leg.from.name },
        geometry: { type: "Point", coordinates: [leg.from.lng, leg.from.lat] },
      });
    }
    // Add final destination
    const lastLeg = itinerary.legs[itinerary.legs.length - 1];
    pointFeatures.push({
      type: "Feature",
      properties: { name: lastLeg.to.name },
      geometry: { type: "Point", coordinates: [lastLeg.to.lng, lastLeg.to.lat] },
    });

    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: lineFeatures },
    });

    // Street legs (walk/bike/car) — dashed, colored per mode
    map.addLayer({
      id: WALK_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      filter: ["==", ["get", "isStreet"], true],
      paint: {
        "line-color": ["get", "color"],
        "line-width": 4,
        "line-dasharray": [2, 2],
        "line-opacity": lineOpacity,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    // Transit legs — solid colored
    map.addLayer({
      id: TRANSIT_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      filter: ["==", ["get", "isStreet"], false],
      paint: {
        "line-color": ["get", "color"],
        "line-width": 5,
        "line-opacity": lineOpacity,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    // Transfer points
    map.addSource(POINTS_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: pointFeatures },
    });

    map.addLayer({
      id: POINTS_LAYER_ID,
      type: "circle",
      source: POINTS_SOURCE_ID,
      paint: {
        "circle-radius": 6,
        "circle-color": "#fff",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#333",
      },
    });

    // Fit bounds only when the itinerary set or selected index changes, not on
    // every legGeometries update. Comparing the list reference catches new
    // searches that reset the index to 0 (a bare index check would miss them).
    const alreadyFitted =
      fittedRef.current?.list === transitItineraries &&
      fittedRef.current?.index === activeItineraryIndex;
    if (!alreadyFitted) {
      fittedRef.current = { list: transitItineraries, index: activeItineraryIndex };
      const allCoords: [number, number][] = [];
      for (const leg of itinerary.legs) {
        for (const coord of leg.geometry.coordinates) {
          allCoords.push(coord);
        }
      }
      if (allCoords.length >= 2) {
        const lngs = allCoords.map((c) => c[0]);
        const lats = allCoords.map((c) => c[1]);
        fitBounds(
          [
            [Math.min(...lngs), Math.min(...lats)],
            [Math.max(...lngs), Math.max(...lats)],
          ],
          80,
        );
      }
    }

    return cleanup;
  }, [
    mapRef,
    mapReady,
    styleVersion,
    mode,
    transitItineraries,
    activeItineraryIndex,
    fitBounds,
    legGeometries,
    navActive,
    navLegIndex,
  ]);

  return null;
}
