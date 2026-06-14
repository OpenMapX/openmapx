"use client";

import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";
import type { AreaGeometry } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { baseMapCustomAttribution, loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";
import type { OfflineAreaBbox } from "@/lib/offlineAreas";

type GeoJSONSource = maplibregl.GeoJSONSource;

const BOUNDARY_SOURCE = "picker-boundary-source";
const BOUNDARY_FILL = "picker-boundary-fill";
const BOUNDARY_LINE = "picker-boundary-line";
// Muted red, matching PlaceBoundaryLayer's area highlight.
const BOUNDARY_COLOR = "#A52714";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface Props {
  initialCenter: [number, number];
  initialZoom: number;
  onChange: (bbox: OfflineAreaBbox, zoom: number) => void;
  /** When set/changed, the map animates to fit this bbox (e.g. a searched admin area). */
  fitBbox?: OfflineAreaBbox | null;
  /** Admin-boundary outline to highlight inside the picker (drawn in muted red). */
  boundary?: AreaGeometry | null;
}

function addBoundaryLayers(map: maplibregl.Map): void {
  if (map.getSource(BOUNDARY_SOURCE)) return;
  map.addSource(BOUNDARY_SOURCE, { type: "geojson", data: EMPTY });
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

function applyBoundary(map: maplibregl.Map | null, boundary: AreaGeometry | null): void {
  const raw = map?.getSource(BOUNDARY_SOURCE);
  if (!raw || raw.type !== "geojson") return;
  (raw as GeoJSONSource).setData(
    boundary
      ? {
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry: boundary }],
        }
      : EMPTY,
  );
}

/**
 * Mini MapLibre instance used as the bbox picker. Whatever the user has visible
 * is the area they'll download — a simple, gesture-driven "download offline
 * area" picker. An optional `fitBbox` lets a
 * search result frame the map automatically, and `boundary` highlights the
 * selected admin area's outline so it's clear what's being captured.
 */
export function AreaPickerMap({ initialCenter, initialZoom, onChange, fitBbox, boundary }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Latest boundary, read by the map's `load` handler (which may run after the
  // boundary prop has already arrived).
  const boundaryRef = useRef<AreaGeometry | null>(boundary ?? null);
  boundaryRef.current = boundary ?? null;
  const env = useEnv();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const styleName = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";

  // biome-ignore lint/correctness/useExhaustiveDependencies: initialCenter / initialZoom intentionally captured at mount only — re-creating the map on every prop change would lose the user's pan/zoom state mid-selection.
  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;
    let map: maplibregl.Map | null = null;

    const init = async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (destroyed || !containerRef.current) return;
      const style =
        env.styleProvider === "openmapx"
          ? await loadOpenMapXStyle(env)
          : await loadMaptilerStyle(styleName, env);
      if (destroyed || !containerRef.current) return;
      map = new maplibregl.Map({
        container: containerRef.current,
        style: style as string | maplibregl.StyleSpecification,
        center: initialCenter,
        zoom: initialZoom,
        attributionControl: { compact: true, customAttribution: baseMapCustomAttribution(env) },
        canvasContextAttributes: { antialias: true },
        // Keep the picker north-up: a rotated/pitched viewport makes the
        // downloaded bounding box (always axis-aligned) confusing to reason about.
        dragRotate: false,
        pitchWithRotate: false,
        rollEnabled: false,
        touchPitch: false,
      });
      // touchZoomRotate stays enabled for pinch-zoom, but disable its rotation.
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      mapRef.current = map;

      const emit = () => {
        if (!map) return;
        const b = map.getBounds();
        onChange(
          {
            west: b.getWest(),
            south: b.getSouth(),
            east: b.getEast(),
            north: b.getNorth(),
          },
          map.getZoom(),
        );
      };

      map.on("load", () => {
        if (!map) return;
        addBoundaryLayers(map);
        applyBoundary(map, boundaryRef.current);
        emit();
      });
      map.on("moveend", emit);
    };

    // `loadMaptilerStyle`/`loadOpenMapXStyle` reject on a failed style fetch;
    // swallow it (leave the container empty) rather than emit an unhandled
    // rejection — same degradation as the place mini-map.
    void init().catch(() => {});

    return () => {
      destroyed = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [env, styleName, onChange]);

  // Frame the map to an externally-provided bbox (e.g. a searched admin area).
  // The ensuing `moveend` re-emits the viewport bbox, so the download captures
  // exactly what's framed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitBbox) return;
    const fit = () =>
      map.fitBounds(
        [
          [fitBbox.west, fitBbox.south],
          [fitBbox.east, fitBbox.north],
        ],
        { padding: 24, duration: 600 },
      );
    if (map.isStyleLoaded()) fit();
    else map.once("load", fit);
  }, [fitBbox]);

  // Sync the highlighted boundary outline whenever it changes.
  useEffect(() => {
    applyBoundary(mapRef.current, boundary ?? null);
  }, [boundary]);

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
    </Box>
  );
}
