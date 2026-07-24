"use client";

import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { baseMapCustomAttribution, loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";
import type { OfflineArea, OfflineAreaBbox } from "@/lib/offlineAreas";

const RECT_SOURCE = "offline-areas-source";
const RECT_FILL = "offline-areas-fill";
const RECT_LINE = "offline-areas-line";
// Brand color so the highlighted download extents read as "ours".
const RECT_COLOR = "#43A047";

function areaToFeature(area: OfflineArea): GeoJSON.Feature {
  const { west, south, east, north } = area.bbox;
  return {
    type: "Feature",
    properties: { name: area.name },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

/** Smallest bbox enclosing every area, or null when there are none. */
function unionBbox(areas: OfflineArea[]): OfflineAreaBbox | null {
  if (areas.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const a of areas) {
    west = Math.min(west, a.bbox.west);
    south = Math.min(south, a.bbox.south);
    east = Math.max(east, a.bbox.east);
    north = Math.max(north, a.bbox.north);
  }
  return { west, south, east, north };
}

function addRectLayers(map: maplibregl.Map, features: GeoJSON.Feature[]): void {
  if (map.getSource(RECT_SOURCE)) return;
  map.addSource(RECT_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });
  map.addLayer({
    id: RECT_FILL,
    type: "fill",
    source: RECT_SOURCE,
    paint: { "fill-color": RECT_COLOR, "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: RECT_LINE,
    type: "line",
    source: RECT_SOURCE,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": RECT_COLOR, "line-width": 2, "line-opacity": 0.9 },
  });
}

interface Props {
  /** Areas to outline. The map renders downloaded tiles for these from cache. */
  areas: OfflineArea[];
  /** Bbox to frame on load; defaults to the union of all areas (else world view). */
  fitTo?: OfflineAreaBbox | null;
  height?: number;
}

/**
 * Read-only MapLibre view used to inspect downloaded offline areas. Renders the
 * same base style the areas were downloaded with — so when framed on a single
 * area, the cached tiles fill in (offline-first via the service worker) — and
 * outlines each area's extent. Rotation is locked to keep the axis-aligned
 * download rectangles legible.
 */
export function OfflineMapView({ areas, fitTo, height = 360 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const env = useEnv();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const styleName = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";
  const variant = resolvedMode === "dark" ? "dark" : "light";

  // biome-ignore lint/correctness/useExhaustiveDependencies: areas/fitTo captured at mount — this is a snapshot viewer, not a live editor; callers remount it per selection.
  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;
    let map: maplibregl.Map | null = null;

    const frame = fitTo ?? unionBbox(areas);

    const init = async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (destroyed || !containerRef.current) return;
      const style =
        env.styleProvider === "openmapx"
          ? await loadOpenMapXStyle(env, variant)
          : await loadMaptilerStyle(styleName, env);
      if (destroyed || !containerRef.current) return;
      map = new maplibregl.Map({
        container: containerRef.current,
        style: style as string | maplibregl.StyleSpecification,
        center: frame ? [(frame.west + frame.east) / 2, (frame.south + frame.north) / 2] : [0, 20],
        zoom: frame ? 6 : 1,
        attributionControl: { compact: true, customAttribution: baseMapCustomAttribution(env) },
        canvasContextAttributes: { antialias: true },
        // North-up only: the download rectangles are axis-aligned.
        dragRotate: false,
        pitchWithRotate: false,
        rollEnabled: false,
        touchPitch: false,
      });
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();

      map.on("load", () => {
        if (!map) return;
        map.resize();
        addRectLayers(map, areas.map(areaToFeature));
        if (frame) {
          map.fitBounds(
            [
              [frame.west, frame.south],
              [frame.east, frame.north],
            ],
            { padding: 32, duration: 0 },
          );
        }
      });
    };

    // `loadMaptilerStyle`/`loadOpenMapXStyle` reject on a failed style fetch;
    // swallow it (leave the container empty) rather than emit an unhandled
    // rejection — same degradation as the place mini-map.
    void init().catch(() => {});

    return () => {
      destroyed = true;
      map?.remove();
    };
  }, [env, styleName, variant]);

  return (
    <Box
      sx={{
        position: "relative",
        width: "100%",
        height,
        borderRadius: 2,
        overflow: "hidden",
        border: 1,
        borderColor: "divider",
      }}
    >
      <Box ref={containerRef} sx={{ position: "absolute", inset: 0 }} />
    </Box>
  );
}
