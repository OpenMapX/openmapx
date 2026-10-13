"use client";

import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { RasterBaseLayer } from "./RasterBaseLayer";

export function CyclingBaseLayer() {
  const env = useEnv();
  const tileUrl = env.cyclOsmTileUrlTemplate;
  return (
    <RasterBaseLayer
      sourceId="openmapx-cyclosm-source"
      layerId="openmapx-cyclosm-layer"
      tiles={[tileUrl]}
      activeWhen="cycling"
      maxzoom={20}
      attributions={[]}
      receiptMode="response"
      paint={{ "raster-opacity": 0.95 }}
    />
  );
}
