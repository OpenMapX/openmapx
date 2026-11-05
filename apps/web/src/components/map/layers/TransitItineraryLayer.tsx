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
import { TransitWalkRouteLayer } from "./TransitWalkRouteLayer";

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
  activeWalkIndex: number | null,
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
        filter:
          activeWalkIndex === null
            ? ["==", ["get", "isStreet"], true]
            : ["all", ["==", ["get", "isStreet"], true], ["!=", ["get", "index"], activeWalkIndex]],
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
  const navActive = useNavigationStore(
    (s) => s.status !== "idle" && s.status !== "arrived" && s.kind === "transit",
  );
  const navLegIndex = useNavigationStore((s) => s.transitProgress?.currentLegIndex ?? 0);
  const navItinerary = useNavigationStore((s) => s.itinerary);
  const candidate = navActive
    ? navItinerary
    : mode === "transit"
      ? transitItineraries[activeItineraryIndex]
      : undefined;
  const itinerary = candidate && candidate.legs.length > 0 ? candidate : null;
  const activeWalk =
    navActive &&
    itinerary?.legs[navLegIndex]?.mode === "walking" &&
    itinerary.legs[navLegIndex].geometry.coordinates.length >= 2
      ? itinerary.legs[navLegIndex]
      : null;
  const activeWalkIndex = activeWalk ? navLegIndex : null;

  useRenderedMapAttributions(
    "transit-itinerary",
    [WALK_LAYER_ID, TRANSIT_LAYER_ID, POINTS_LAYER_ID],
    !!itinerary,
  );

  // Refined per-leg geometries fetched lazily from /leg-geometry after the
  // itinerary is selected. Keyed by tripId; replaces stopovers geometry when available.
  const [legGeometries, setLegGeometries] = useState<Record<string, GeoJSONLineString>>({});
  // Track the fetch generation so stale responses from a previous itinerary are discarded.
  const fetchGenRef = useRef(0);
  // Track which (itinerary list, index) pair has already had bounds fitted.
  // Keying on the list reference catches new searches that reset the index back
  // to 0, which a bare index comparison would miss.
  const fittedRef = useRef<{ list: typeof transitItineraries; index: number } | null>(null);

  // A native restore can have no directions preview. Refine exactly the
  // displayed trips, retaining results across equivalent full snapshots.
  const refinementKey = JSON.stringify(
    (itinerary?.legs ?? [])
      .filter(shouldRefineLegGeometry)
      .map((leg) => [leg.tripId, leg.from.stopId ?? null, leg.to.stopId ?? null]),
  );
  useEffect(() => {
    const gen = ++fetchGenRef.current;
    setLegGeometries({});
    const requests = JSON.parse(refinementKey) as Array<[string, string | null, string | null]>;
    void Promise.allSettled(
      requests.map(async ([tripId, from, to]) => {
        if (!tripId) return;
        try {
          const params: Record<string, string> = { trip_id: tripId };
          if (from) params.from_stop_id = from;
          if (to) params.to_stop_id = to;
          const env = await apiClient.get<MobilityEnvelope<GeoJSONLineString>>(
            API_ENDPOINTS.transitLegGeometry,
            params,
          );
          const geo = env.data;
          if (fetchGenRef.current === gen && geo?.coordinates?.length >= 2)
            setLegGeometries((prev) => ({ ...prev, [tripId]: geo }));
        } catch {
          /* Keep the captured inline geometry. */
        }
      }),
    );
    return () => {
      fetchGenRef.current++;
    };
  }, [refinementKey]);

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
          ? transitItineraryGroup(lineData, pointData, navActive, navLegIndex, activeWalkIndex)
          : null,
      [lineData, pointData, navActive, navLegIndex, activeWalkIndex],
    ),
  );

  // Fit bounds only when the itinerary set or selected index changes, not when
  // refined leg geometry arrives. Comparing the list reference catches new
  // searches that reset the index to 0 (a bare index check would miss them).
  useEffect(() => {
    if (!mapReady || !itinerary || navActive) return;
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
  }, [mapReady, itinerary, transitItineraries, activeItineraryIndex, fitBounds, navActive]);

  return <TransitWalkRouteLayer leg={activeWalk} legIndex={navLegIndex} />;
}
