"use client";

import Box from "@mui/material/Box";
import type { AreaGeometry } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { MapCredits } from "@/components/map/MapCredits";
import { useStandaloneBasemapStyle, useStandaloneMap } from "@/components/map/useStandaloneMap";
import { createGeoJsonSourceDataBridge } from "@/integration-api/map/layerStyleUtils";
import { EMPTY_FEATURE_COLLECTION } from "@/integration-api/map/mapLayerGroup";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { baseMapVectorCredits } from "@/lib/map";
import type { OfflinePackageBbox } from "@/lib/offlineAreas";
import { fitPackageBbox } from "./fitPackageBbox";

const BOUNDARY_SOURCE = "picker-boundary-source";
const BOUNDARY_FILL = "picker-boundary-fill";
const BOUNDARY_LINE = "picker-boundary-line";
// Muted red, matching PlaceBoundaryLayer's area highlight.
const BOUNDARY_COLOR = "#A52714";

interface Props {
  initialCenter: [number, number];
  initialZoom: number;
  onChange: (bbox: OfflinePackageBbox, zoom: number) => void;
  /** When set/changed, the map animates to fit this bbox (e.g. a searched admin area). */
  fitBbox?: OfflinePackageBbox | null;
  /** Admin-boundary outline to highlight inside the picker (drawn in muted red). */
  boundary?: AreaGeometry | null;
}

function addBoundaryLayers(map: maplibregl.Map): void {
  if (map.getSource(BOUNDARY_SOURCE)) return;
  map.addSource(BOUNDARY_SOURCE, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  map.addLayer({
    id: BOUNDARY_FILL,
    type: "fill",
    source: BOUNDARY_SOURCE,
    paint: { "fill-color": BOUNDARY_COLOR, "fill-opacity": 0.05 },
  });
  map.addLayer({
    id: BOUNDARY_LINE,
    type: "line",
    source: BOUNDARY_SOURCE,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": BOUNDARY_COLOR,
      "line-width": 2.5,
      "line-opacity": 0.9,
      "line-dasharray": [1.5, 2],
    },
  });
}

function boundaryData(boundary: AreaGeometry | null): GeoJSON.FeatureCollection {
  return boundary
    ? {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: boundary }],
      }
    : EMPTY_FEATURE_COLLECTION;
}

const FIT_OPTIONS = { padding: 24, duration: 600 };

/**
 * Mini MapLibre instance used as the bbox picker. Whatever the user has visible
 * is the area they'll download — a simple, gesture-driven "download offline
 * area" picker. An optional `fitBbox` lets a
 * search result frame the map automatically, and `boundary` highlights the
 * selected admin area's outline so it's clear what's being captured.
 */
export function AreaPickerMap({ initialCenter, initialZoom, onChange, fitBbox, boundary }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [boundaryBridge] = useState(createGeoJsonSourceDataBridge);
  // The parent updates its bbox state from this callback. Keep the callback
  // current without making it a map-lifecycle dependency: an inline callback
  // from the parent must not tear down and recreate the map on every move.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Keep inputs current while the map's asynchronous construction is pending.
  const fitBboxRef = useRef(fitBbox);
  fitBboxRef.current = fitBbox;
  const env = useEnv();
  const loadStyle = useStandaloneBasemapStyle();

  // initialCenter / initialZoom are captured at construction only: recreating
  // the map on every prop change would lose the user's pan/zoom mid-selection.
  const mapRef = useStandaloneMap(
    containerRef,
    () => ({
      loadStyle,
      options: {
        center: initialCenter,
        zoom: initialZoom,
        // Keep the picker north-up: a rotated/pitched viewport makes the
        // downloaded bounding box (always axis-aligned) confusing to reason about.
        dragRotate: false,
        pitchWithRotate: false,
        rollEnabled: false,
        touchPitch: false,
      },
      setup: (map) => {
        // touchZoomRotate stays enabled for pinch-zoom, but disable its rotation.
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
        if (fitBboxRef.current) fitPackageBbox(map, fitBboxRef.current, FIT_OPTIONS);

        const emit = () => {
          const b = map.getBounds();
          onChangeRef.current(
            { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
            map.getZoom(),
          );
        };
        const unsubscribeStyle = subscribeStyleLoaded(map, () => {
          addBoundaryLayers(map);
          boundaryBridge.apply(map);
        });
        emit();
        map.on("moveend", emit);
        return () => {
          unsubscribeStyle();
          map.off("moveend", emit);
        };
      },
    }),
    [boundaryBridge, loadStyle],
  );

  // Frame the map to an externally-provided bbox (e.g. a searched admin area).
  // The ensuing `moveend` re-emits the viewport bbox, so the download captures
  // exactly what's framed.
  useEffect(() => {
    const map = mapRef.current;
    if (map && fitBbox) fitPackageBbox(map, fitBbox, FIT_OPTIONS);
  }, [fitBbox, mapRef]);

  // Sync the highlighted boundary outline whenever it changes.
  useEffect(() => {
    const map = mapRef.current;
    boundaryBridge.publish([{ sourceId: BOUNDARY_SOURCE, data: boundaryData(boundary ?? null) }]);
    if (map) boundaryBridge.apply(map);
  }, [boundary, boundaryBridge, mapRef]);

  return (
    <Box
      sx={{
        position: "relative",
        width: "100%",
        height: 320,
        borderRadius: 2,
        overflow: "hidden",
        border: 1,
        borderColor: "divider",
      }}
    >
      <Box ref={containerRef} sx={{ position: "absolute", inset: 0 }} />
      {/* Crosshair overlay — visualizes the bbox extent that will be downloaded */}
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          "&::before": {
            content: '""',
            position: "absolute",
            inset: 12,
            border: "2px dashed rgba(0,0,0,0.45)",
            borderRadius: 1,
          },
        }}
      />
      <MapCredits attributions={baseMapVectorCredits(env)} />
    </Box>
  );
}
