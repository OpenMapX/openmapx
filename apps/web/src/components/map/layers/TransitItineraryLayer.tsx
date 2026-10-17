"use client";

import {
  API_ENDPOINTS,
  apiClient,
  MODE_COLORS,
  routeColor,
  useDirectionsStore,
  useNavigationStore,
} from "@openmapx/core";
import {
  contributorsForField,
  serializeContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type {
  GeoJSONLineString,
  TransportMode,
  TripItinerary,
} from "@openmapx/mobility-core/transit";
import type { ExpressionSpecification } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { PRIMARY_BLUE_HEX } from "@/integration-api/runtime/theme";
import { ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { shouldRefineLegGeometry } from "./legGeometryRefine";

// Non-transit "street" legs (walk plus intermodal bike/car access) render as
// dashed lines — like the panel's street-leg styling — vs solid transit lines.
const STREET_MODES = new Set<TransportMode>(["walking", "cycling", "driving"]);

const SOURCE_ID = "transit-itinerary-source";
const WALK_LAYER_ID = "transit-itinerary-walk";
const CASING_LAYER_ID = "transit-itinerary-casing";
const TRANSIT_LAYER_ID = "transit-itinerary-transit";
const POINTS_SOURCE_ID = "transit-itinerary-points-source";
const POINTS_LAYER_ID = "transit-itinerary-points";

// One line feature per leg; refined trip geometry replaces the inline one when available.
function legLineFeatures(
  itinerary: TripItinerary,
  legGeometries: Record<string, GeoJSONLineString>,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: itinerary.legs.map((leg, i) => {
      const isStreet = STREET_MODES.has(leg.mode);
      const color = isStreet
        ? (MODE_COLORS[leg.mode] ?? "#757575")
        : routeColor({ color: leg.route?.color, mode: leg.mode }, PRIMARY_BLUE_HEX);
      const geometry = (leg.tripId ? legGeometries[leg.tripId] : undefined) ?? leg.geometry;

      return {
        type: "Feature" as const,
        properties: {
          _mapAttributions: serializeContributors(
            snapshotContributors(
              geometry.contributors ?? contributorsForField(leg, "geometry"),
              contributorsForField(leg, isStreet || !leg.route?.color ? "mode" : "route.color"),
            ),
          ),
          isStreet,
          color,
          index: i,
        },
        geometry,
      };
    }),
  };
}

// Every leg's boarding point plus the final destination.
function transferPointFeatures(itinerary: TripItinerary): GeoJSON.FeatureCollection {
  const features: Array<{
    type: "Feature";
    properties: { name: string; _mapAttributions: string };
    geometry: { type: "Point"; coordinates: [number, number] };
  }> = [];

  for (const leg of itinerary.legs) {
    features.push({
      type: "Feature",
      properties: {
        name: leg.from.name,
        _mapAttributions: serializeContributors(
          leg.from.contributors ?? contributorsForField(leg, "from"),
        ),
      },
      geometry: { type: "Point", coordinates: [leg.from.lng, leg.from.lat] },
    });
  }
  const lastLeg = itinerary.legs[itinerary.legs.length - 1];
  features.push({
    type: "Feature",
    properties: {
      name: lastLeg.to.name,
      _mapAttributions: serializeContributors(
        lastLeg.to.contributors ?? contributorsForField(lastLeg, "to"),
      ),
    },
    geometry: { type: "Point", coordinates: [lastLeg.to.lng, lastLeg.to.lat] },
  });

  return { type: "FeatureCollection", features };
}

function transitItineraryGroup(
  lineData: GeoJSON.FeatureCollection,
  pointData: GeoJSON.FeatureCollection,
  navActive: boolean,
  navLegIndex: number,
): MapLayerGroup {
  // When following a transit trip, dim non-current legs; otherwise full opacity.
  const lineOpacity: ExpressionSpecification | number = navActive
    ? ["case", ["==", ["get", "index"], navLegIndex], 1, 0.3]
    : 1;
  const widths = navActive ? ROUTE_WIDTHS.nav : ROUTE_WIDTHS.planning;

  return {
    sources: {
      [SOURCE_ID]: { type: "geojson", data: lineData },
      [POINTS_SOURCE_ID]: { type: "geojson", data: pointData },
    },
    layers: [
      // The chosen trip sits in the route slot with the same white casing as a
      // driving route, above any transit-network overlay, so a line coloured like
      // its neighbours in the network still reads as the one being taken.
      {
        id: CASING_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        slot: "route-active",
        order: 5,
        filter: ["==", ["get", "isStreet"], false],
        paint: {
          "line-color": ROUTE_COLORS.casing,
          "line-width": widths.casing,
          "line-opacity": lineOpacity,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      },
      // Street legs (walk/bike/car) — dashed, colored per mode
      {
        id: WALK_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        slot: "route-active",
        order: 6,
        filter: ["==", ["get", "isStreet"], true],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 4,
          "line-dasharray": [2, 2],
          "line-opacity": lineOpacity,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      },
      // Transit legs — solid colored
      {
        id: TRANSIT_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        slot: "route-active",
        order: 7,
        filter: ["==", ["get", "isStreet"], false],
        paint: {
          "line-color": ["get", "color"],
          "line-width": widths.line,
          "line-opacity": lineOpacity,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      },
      {
        id: POINTS_LAYER_ID,
        type: "circle",
        source: POINTS_SOURCE_ID,
        slot: "overlay-points",
        order: 20,
        paint: {
          "circle-radius": 6,
          "circle-color": "#fff",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#333",
        },
      },
    ],
  };
}

export function TransitItineraryLayer() {
  const { mapReady, fitBounds } = useMap();
  const { mode, transitItineraries, activeItineraryIndex } = useDirectionsStore();

  useRenderedMapAttributions(
    "transit-itinerary",
    [WALK_LAYER_ID, TRANSIT_LAYER_ID, POINTS_LAYER_ID],
    mode === "transit" && transitItineraries.length > 0,
  );

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

    // Only legs whose inline geometry is coarse (stop-connected) benefit from a
    // `/leg-geometry` refinement. MOTIS already embeds the full track polyline
    // and has no leg-geometry endpoint, so refining those would just 404.
    const transitLegs = itinerary.legs.filter(shouldRefineLegGeometry);
    if (transitLegs.length === 0) return;

    void Promise.allSettled(
      transitLegs.map(async (leg) => {
        if (!leg.tripId) return;
        const { tripId } = leg;
        try {
          const params: Record<string, string> = { trip_id: tripId };
          if (leg.from.stopId) params.from_stop_id = leg.from.stopId;
          if (leg.to.stopId) params.to_stop_id = leg.to.stopId;
          const env = await apiClient.get<MobilityEnvelope<GeoJSONLineString>>(
            API_ENDPOINTS.transitLegGeometry,
            params,
          );
          const geo = env.data;
          if (fetchGenRef.current === gen && geo?.coordinates?.length >= 2) {
            setLegGeometries((prev) => ({ ...prev, [tripId]: geo }));
          }
        } catch {
          // geometry not available for this leg — stopovers geometry is used
        }
      }),
    );
  }, [mode, transitItineraries, activeItineraryIndex]);

  const candidate = mode === "transit" ? transitItineraries[activeItineraryIndex] : undefined;
  const itinerary = candidate && candidate.legs.length > 0 ? candidate : null;
  const lineData = useMemo(
    () => (itinerary ? legLineFeatures(itinerary, legGeometries) : null),
    [itinerary, legGeometries],
  );
  const pointData = useMemo(
    () => (itinerary ? transferPointFeatures(itinerary) : null),
    [itinerary],
  );
  useMapLayerGroup(
    useMemo(
      () =>
        lineData && pointData
          ? transitItineraryGroup(lineData, pointData, navActive, navLegIndex)
          : null,
      [lineData, pointData, navActive, navLegIndex],
    ),
  );

  // Fit bounds only when the itinerary set or selected index changes, not when
  // refined leg geometry arrives. Comparing the list reference catches new
  // searches that reset the index to 0 (a bare index check would miss them).
  useEffect(() => {
    if (!mapReady || !itinerary) return;
    const alreadyFitted =
      fittedRef.current?.list === transitItineraries &&
      fittedRef.current?.index === activeItineraryIndex;
    if (alreadyFitted) return;
    fittedRef.current = { list: transitItineraries, index: activeItineraryIndex };
    const allCoords: [number, number][] = [];
    for (const leg of itinerary.legs) {
      for (const coord of leg.geometry.coordinates) {
        allCoords.push(coord);
      }
    }
    if (allCoords.length < 2) return;
    const lngs = allCoords.map((c) => c[0]);
    const lats = allCoords.map((c) => c[1]);
    fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      80,
    );
  }, [mapReady, itinerary, transitItineraries, activeItineraryIndex, fitBounds]);

  return null;
}
