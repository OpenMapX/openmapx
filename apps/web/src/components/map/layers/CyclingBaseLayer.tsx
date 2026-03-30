"use client";

import { useLayerStore } from "@openmapx/core";
import { useEffect, useRef, useState } from "react";
import { RasterBaseLayer } from "./RasterBaseLayer";

const CYCLOSM_ATTRIBUTION =
  '© <a href="https://www.cyclosm.org/" target="_blank">CyclOSM</a> hosted by <a href="https://openstreetmap.fr/" target="_blank">OpenStreetMap France</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors (<a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank">CC-BY-SA</a>)';

const THUNDERFOREST_ATTRIBUTION =
  '© <a href="https://www.thunderforest.com/maps/opencyclemap/" target="_blank">Thunderforest OpenCycleMap</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors (<a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank">CC-BY-SA</a>)';

const tileUrl =
  process.env.NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE ||
  (process.env.NEXT_PUBLIC_API_URL
    ? `${process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "")}/api/tiles/cyclosm/{z}/{x}/{y}.png`
    : "/api/tiles/cyclosm/{z}/{x}/{y}.png");

export function CyclingBaseLayer() {
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const [attribution, setAttribution] = useState(CYCLOSM_ATTRIBUTION);
  const probed = useRef(false);

  useEffect(() => {
    if (activeLayer !== "cycling" || probed.current) return;
    probed.current = true;

    const probeUrl = tileUrl.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0");

    fetch(probeUrl, { method: "HEAD" })
      .then((res) => {
        const source = res.headers.get("X-Tile-Source");
        if (source === "thunderforest") {
          setAttribution(THUNDERFOREST_ATTRIBUTION);
        }
      })
      .catch(() => {});
  }, [activeLayer]);

  return (
    <RasterBaseLayer
      sourceId="openmapx-cyclosm-source"
      layerId="openmapx-cyclosm-layer"
      tiles={[tileUrl]}
      activeWhen="cycling"
      maxzoom={20}
      attribution={attribution}
      paint={{ "raster-opacity": 0.95 }}
    />
  );
}
