"use client";

import Box from "@mui/material/Box";
import type * as maplibregl from "maplibre-gl";
import { useRef } from "react";
import { MapCredits } from "@/components/map/MapCredits";
import { useStandaloneMap, useStandaloneMapVariant } from "@/components/map/useStandaloneMap";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { baseMapVectorCredits, loadOpenMapXStyle } from "@/lib/map";
import {
  configureDefaultOfflinePackageResolver,
  getDefaultOfflinePackageResolver,
  type OfflinePackageBbox,
  type OfflinePackageRecord,
  registerOfflinePmtilesProtocol,
} from "@/lib/offlineAreas";
import { fitPackageBbox } from "./fitPackageBbox";

const RECT_SOURCE = "offline-packages-source";
const RECT_FILL = "offline-packages-fill";
const RECT_LINE = "offline-packages-line";
const RECT_COLOR = "#207E23";

function packageToFeature(record: OfflinePackageRecord): GeoJSON.Feature {
  const { west, south, east, north } = record.manifest.coverage.bbox;
  return {
    type: "Feature",
    properties: { name: record.name },
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

function unionBbox(packages: OfflinePackageRecord[]): OfflinePackageBbox | null {
  if (packages.length === 0) return null;
  return packages.reduce<OfflinePackageBbox>(
    (box, record) => ({
      west: Math.min(box.west, record.manifest.coverage.bbox.west),
      south: Math.min(box.south, record.manifest.coverage.bbox.south),
      east: Math.max(box.east, record.manifest.coverage.bbox.east),
      north: Math.max(box.north, record.manifest.coverage.bbox.north),
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity },
  );
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
  packages: OfflinePackageRecord[];
  fitTo?: OfflinePackageBbox | null;
  height?: number;
}

export function OfflineMapView({ packages, fitTo, height = 360 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const env = useEnv();
  const variant = useStandaloneMapVariant();

  useStandaloneMap(containerRef, () => {
    if (packages.length === 0) return null;
    const frame = fitTo ?? unionBbox(packages);
    return {
      loadStyle: async (runtime) => {
        const resolver =
          getDefaultOfflinePackageResolver() ??
          configureDefaultOfflinePackageResolver({ tileSchema: "openmaptiles" });
        if (!resolver) throw new Error("offline package resolver is not initialized");
        await resolver.refresh();
        const style = await loadOpenMapXStyle(
          env,
          variant,
          packages.map((record) => ({ packageId: record.id, manifest: record.manifest })),
        );
        registerOfflinePmtilesProtocol(runtime, resolver);
        return style as maplibregl.StyleSpecification;
      },
      options: {
        center: frame ? [(frame.west + frame.east) / 2, (frame.south + frame.north) / 2] : [0, 20],
        zoom: frame ? 6 : 1,
        dragRotate: false,
        pitchWithRotate: false,
        rollEnabled: false,
        touchPitch: false,
      },
      setup: (map) => {
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
        const features = packages.map(packageToFeature);
        const unsubscribeStyle = subscribeStyleLoaded(map, () => addRectLayers(map, features));
        if (frame) fitPackageBbox(map, frame, { padding: 32, duration: 0 });
        return unsubscribeStyle;
      },
    };
  }, [env, fitTo, packages, variant]);

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
      {packages.length === 0 ? null : (
        <MapCredits attributions={baseMapVectorCredits({ ...env, tilesUrl: "offline-package" })} />
      )}
    </Box>
  );
}
