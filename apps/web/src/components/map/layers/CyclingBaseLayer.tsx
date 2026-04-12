"use client";

import { buildAttributionHtml, useLayerStore } from "@openmapx/core";
import { useEffect, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { RasterBaseLayer } from "./RasterBaseLayer";

const OSM_ATTRIBUTION = buildAttributionHtml({
  name: "OpenStreetMap",
  url: "https://www.openstreetmap.org/copyright",
  license: "CC-BY-SA",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> (<a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank" rel="noopener noreferrer">CC-BY-SA</a>)',
});

const CYCLOSM_ATTRIBUTION = [
  buildAttributionHtml({
    name: "CyclOSM",
    url: "https://www.cyclosm.org/",
    license: "",
    attribution:
      '© <a href="https://www.cyclosm.org/" target="_blank" rel="noopener noreferrer">CyclOSM</a> hosted by <a href="https://openstreetmap.fr/" target="_blank" rel="noopener noreferrer">OpenStreetMap France</a>',
  }),
  OSM_ATTRIBUTION,
].join(" · ");

const THUNDERFOREST_ATTRIBUTION = [
  buildAttributionHtml({
    name: "Thunderforest OpenCycleMap",
    url: "https://www.thunderforest.com/maps/opencyclemap/",
    license: "",
  }),
  OSM_ATTRIBUTION,
].join(" · ");

export function CyclingBaseLayer() {
  const env = useEnv();
  const tileUrl = env.cyclOsmTileUrlTemplate;
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
  }, [activeLayer, tileUrl]);

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
