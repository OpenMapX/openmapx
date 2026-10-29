"use client";

import { usePlaceStopInfrastructure, usePlaceStore } from "@openmapx/core";
import { serializeContributors } from "@openmapx/mobility-core/contributors";
import type {
  TransitGeoJsonMultiPolygon,
  TransitGeoJsonPolygon,
  TransitStopInfrastructure,
} from "@openmapx/mobility-core/transit";
import { useEffect, useMemo, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import {
  EMPTY_FEATURE_COLLECTION,
  type MapLayerGroup,
  type SlottedLayer,
} from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";

const STOP_AREA_SOURCE_ID = "selected-stop-area-source";
const STOP_AREA_FILL_LAYER_ID = "selected-stop-area-fill";
const STOP_AREA_OUTLINE_LAYER_ID = "selected-stop-area-outline";
const FARE_ZONE_SOURCE_ID = "selected-stop-fare-zone-source";
const FARE_ZONE_FILL_LAYER_ID = "selected-stop-fare-zone-fill";
const FARE_ZONE_OUTLINE_LAYER_ID = "selected-stop-fare-zone-outline";
const PLATFORM_SOURCE_ID = "selected-stop-platform-source";
const PLATFORM_LAYER_ID = "selected-stop-platforms";
const PLATFORM_LABEL_LAYER_ID = "selected-stop-platform-labels";
const PARKING_SOURCE_ID = "selected-stop-parking-source";
const PARKING_LAYER_ID = "selected-stop-parking";

type TransitPolygonGeometry = TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon;

function geometryBounds(
  geometry: TransitPolygonGeometry | null | undefined,
): [[number, number], [number, number]] | null {
  if (!geometry) return null;

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const visitPoint = ([lng, lat]: [number, number]) => {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  };

  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) {
      for (const point of ring) visitPoint(point);
    }
  } else {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        for (const point of ring) visitPoint(point);
      }
    }
  }

  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

function stopAreaFeature(
  infrastructure: TransitStopInfrastructure | undefined,
): GeoJSON.FeatureCollection {
  const geometry = infrastructure?.geometry?.stopArea;
  return {
    type: "FeatureCollection",
    features: geometry
      ? [
          {
            type: "Feature",
            properties: {
              _mapAttributions: serializeContributors(
                infrastructure.geometry?.stopArea?.contributors ??
                  infrastructure.contributors ??
                  [],
              ),
              stopId: infrastructure.stopId,
            },
            geometry,
          },
        ]
      : [],
  };
}

function fareZoneFeature(
  infrastructure: TransitStopInfrastructure | undefined,
  focusedFareZoneId: string | null,
): GeoJSON.FeatureCollection {
  if (!infrastructure || !focusedFareZoneId) return EMPTY_FEATURE_COLLECTION;

  const zone = infrastructure.geometry?.fareZones?.find(
    (item) => item.fareZoneId === focusedFareZoneId,
  );
  if (!zone) return EMPTY_FEATURE_COLLECTION;

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          _mapAttributions: serializeContributors(
            zone.geometry.contributors ?? zone.contributors ?? infrastructure.contributors ?? [],
          ),
          fareZoneId: zone.fareZoneId,
        },
        geometry: zone.geometry,
      },
    ],
  };
}

function platformFeatures(
  infrastructure: TransitStopInfrastructure | undefined,
  focusedPlatformId: string | null,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features:
      infrastructure?.platforms.map((platform) => ({
        type: "Feature" as const,
        properties: {
          _mapAttributions: serializeContributors(platform.contributors ?? []),
          id: platform.id,
          label: platform.publicCode ?? platform.privateCode ?? "",
          isFocused: platform.id === focusedPlatformId,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [platform.lng, platform.lat] as [number, number],
        },
      })) ?? [],
  };
}

function parkingFeatures(
  infrastructure: TransitStopInfrastructure | undefined,
  focusedParkingId: string | null,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features:
      infrastructure?.parking.map((parking) => ({
        type: "Feature" as const,
        properties: {
          _mapAttributions: serializeContributors(parking.contributors ?? []),
          id: parking.id,
          isFocused: parking.id === focusedParkingId,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [parking.lng, parking.lat] as [number, number],
        },
      })) ?? [],
  };
}

function stopInfrastructureGroup(
  stopAreaData: GeoJSON.FeatureCollection,
  fareZoneData: GeoJSON.FeatureCollection,
  platformData: GeoJSON.FeatureCollection,
  parkingData: GeoJSON.FeatureCollection,
): MapLayerGroup {
  const layers: SlottedLayer[] = [];

  if (stopAreaData.features.length > 0) {
    layers.push(
      {
        id: STOP_AREA_FILL_LAYER_ID,
        type: "fill",
        source: STOP_AREA_SOURCE_ID,
        slot: "area-overlays",
        order: 9,
        paint: {
          "fill-color": "#0F9D58",
          "fill-opacity": 0.12,
        },
      },
      {
        id: STOP_AREA_OUTLINE_LAYER_ID,
        type: "line",
        source: STOP_AREA_SOURCE_ID,
        slot: "overlay-lines",
        order: 13,
        paint: {
          "line-color": "#0F9D58",
          "line-width": 2.5,
          "line-opacity": 0.9,
        },
      },
    );
  }

  if (fareZoneData.features.length > 0) {
    layers.push(
      {
        id: FARE_ZONE_FILL_LAYER_ID,
        type: "fill",
        source: FARE_ZONE_SOURCE_ID,
        slot: "area-overlays",
        order: 10,
        paint: {
          "fill-color": "#D97706",
          "fill-opacity": 0.1,
        },
      },
      {
        id: FARE_ZONE_OUTLINE_LAYER_ID,
        type: "line",
        source: FARE_ZONE_SOURCE_ID,
        slot: "overlay-lines",
        order: 14,
        paint: {
          "line-color": "#D97706",
          "line-width": 2,
          "line-opacity": 0.85,
          "line-dasharray": [2, 1],
        },
      },
    );
  }

  if (platformData.features.length > 0) {
    layers.push(
      {
        id: PLATFORM_LAYER_ID,
        type: "circle",
        source: PLATFORM_SOURCE_ID,
        slot: "overlay-points",
        order: 17,
        paint: {
          "circle-radius": ["case", ["boolean", ["get", "isFocused"], false], 7, 4.5],
          "circle-color": ["case", ["boolean", ["get", "isFocused"], false], "#D97706", "#0F9D58"],
          "circle-stroke-width": ["case", ["boolean", ["get", "isFocused"], false], 3, 2],
          "circle-stroke-color": "#FFFFFF",
        },
      },
      {
        id: PLATFORM_LABEL_LAYER_ID,
        type: "symbol",
        source: PLATFORM_SOURCE_ID,
        slot: "overlay-markers",
        order: 13,
        minzoom: 15.5,
        filter: ["!=", ["get", "label"], ""],
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-font": ["Noto Sans Regular"],
          // These labels sit below the basemap's own symbols, and MapLibre
          // places symbols top-down, so a street or POI label would win the
          // collision and suppress "Gleis 3" entirely — at 15.5+, exactly
          // where basemap labels are densest. Two platform labels crowding
          // each other still reads; the platform's number vanishing while
          // the user is looking for it does not.
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#14532D",
          "text-halo-color": "#FFFFFF",
          "text-halo-width": 1.5,
        },
      },
    );
  }

  if (parkingData.features.length > 0) {
    // `overlay-markers`, not `overlay-points`: these circles belong above
    // `PLATFORM_LABEL_LAYER_ID`, and `overlay-points` sits structurally below
    // `overlay-markers` regardless of the order value within it.
    layers.push({
      id: PARKING_LAYER_ID,
      type: "circle",
      source: PARKING_SOURCE_ID,
      slot: "overlay-markers",
      order: 14,
      paint: {
        "circle-radius": ["case", ["boolean", ["get", "isFocused"], false], 8, 5.5],
        "circle-color": ["case", ["boolean", ["get", "isFocused"], false], "#D97706", "#2563EB"],
        "circle-stroke-width": ["case", ["boolean", ["get", "isFocused"], false], 3, 2],
        "circle-stroke-color": "#FFFFFF",
      },
    });
  }

  return {
    sources: {
      [STOP_AREA_SOURCE_ID]: { type: "geojson", data: stopAreaData },
      [FARE_ZONE_SOURCE_ID]: { type: "geojson", data: fareZoneData },
      [PLATFORM_SOURCE_ID]: { type: "geojson", data: platformData },
      [PARKING_SOURCE_ID]: { type: "geojson", data: parkingData },
    },
    layers,
  };
}

export function SelectedStopInfrastructureLayer() {
  const { mapRef, mapReady, fitBounds, flyTo } = useMap();
  const selectedPlace = usePlaceStore((state) => state.selectedPlace);
  const transitMapFocus = usePlaceStore((state) => state.transitMapFocus);
  const { data: infrastructure } = usePlaceStopInfrastructure(selectedPlace);
  const revealKeyRef = useRef<string | null>(null);

  const isStopMode = selectedPlace?.rawCategory === "transit_stop";
  useRenderedMapAttributions(
    "transit-stop-infrastructure",
    [
      STOP_AREA_FILL_LAYER_ID,
      STOP_AREA_OUTLINE_LAYER_ID,
      FARE_ZONE_FILL_LAYER_ID,
      FARE_ZONE_OUTLINE_LAYER_ID,
      PLATFORM_LAYER_ID,
      PARKING_LAYER_ID,
    ],
    Boolean(isStopMode),
  );
  useRenderedMapAttributions(
    "transit-stop-platform-labels",
    [PLATFORM_LABEL_LAYER_ID],
    Boolean(isStopMode),
  );

  const focusedPlatformId = transitMapFocus?.kind === "platform" ? transitMapFocus.id : null;
  const focusedFareZoneId = transitMapFocus?.kind === "fare-zone" ? transitMapFocus.id : null;
  const focusedParkingId = transitMapFocus?.kind === "parking" ? transitMapFocus.id : null;
  const stopAreaData = useMemo(() => stopAreaFeature(infrastructure), [infrastructure]);
  const fareZoneData = useMemo(
    () => fareZoneFeature(infrastructure, focusedFareZoneId),
    [infrastructure, focusedFareZoneId],
  );
  const platformData = useMemo(
    () => platformFeatures(infrastructure, focusedPlatformId),
    [infrastructure, focusedPlatformId],
  );
  const parkingData = useMemo(
    () => parkingFeatures(infrastructure, focusedParkingId),
    [infrastructure, focusedParkingId],
  );

  const hasVisuals =
    stopAreaData.features.length > 0 ||
    fareZoneData.features.length > 0 ||
    platformData.features.length > 0 ||
    parkingData.features.length > 0;
  const shown = isStopMode && Boolean(infrastructure) && hasVisuals;
  useMapLayerGroup(
    useMemo(
      () =>
        shown
          ? stopInfrastructureGroup(stopAreaData, fareZoneData, platformData, parkingData)
          : null,
      [shown, stopAreaData, fareZoneData, platformData, parkingData],
    ),
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !isStopMode || !infrastructure || !transitMapFocus) return;
    if (transitMapFocus.revealToken <= 0) return;

    const revealKey = [
      selectedPlace?.id ?? "",
      transitMapFocus.kind,
      transitMapFocus.id,
      transitMapFocus.revealToken,
    ].join(":");
    if (revealKeyRef.current === revealKey) return;
    revealKeyRef.current = revealKey;

    if (transitMapFocus.kind === "platform") {
      const platform = infrastructure.platforms.find((item) => item.id === transitMapFocus.id);
      if (platform) {
        flyTo([platform.lng, platform.lat], Math.max(map.getZoom(), 17), { duration: 900 });
        return;
      }
    }

    if (transitMapFocus.kind === "fare-zone") {
      const fareZoneGeometry = infrastructure.geometry?.fareZones?.find(
        (item) => item.fareZoneId === transitMapFocus.id,
      )?.geometry;
      const bounds = geometryBounds(fareZoneGeometry);
      if (bounds) {
        fitBounds(bounds, 60);
        return;
      }
    }

    if (transitMapFocus.kind === "parking") {
      const parking = infrastructure.parking.find((item) => item.id === transitMapFocus.id);
      if (parking) {
        flyTo([parking.lng, parking.lat], Math.max(map.getZoom(), 17), { duration: 900 });
        return;
      }
    }

    const stopAreaBounds = geometryBounds(infrastructure.geometry?.stopArea);
    if (stopAreaBounds) {
      fitBounds(stopAreaBounds, 60);
      return;
    }

    flyTo(
      [infrastructure.canonicalStop.lng, infrastructure.canonicalStop.lat],
      Math.max(map.getZoom(), 16),
      { duration: 900 },
    );
  }, [
    mapRef,
    mapReady,
    fitBounds,
    flyTo,
    isStopMode,
    infrastructure,
    selectedPlace?.id,
    transitMapFocus,
  ]);

  return null;
}
