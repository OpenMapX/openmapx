"use client";

import { useLayerStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { RasterBaseLayer } from "./RasterBaseLayer";

const OSM_ATTRIBUTION: Attribution = {
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/",
};

const CYCLOSM_ATTRIBUTIONS: Attribution[] = [
  {
    sourceId: "cyclosm",
    name: "© CyclOSM",
    url: "https://www.cyclosm.org/",
    publisher: { name: "OpenStreetMap France", url: "https://openstreetmap.fr/" },
  },
  OSM_ATTRIBUTION,
];

const THUNDERFOREST_ATTRIBUTIONS: Attribution[] = [
  {
    sourceId: "thunderforest",
    name: "© Thunderforest OpenCycleMap",
    url: "https://www.thunderforest.com/maps/opencyclemap/",
  },
  OSM_ATTRIBUTION,
];

export function CyclingBaseLayer() {
  const env = useEnv();
  const tileUrl = env.cyclOsmTileUrlTemplate;
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const [provider, setProvider] = useState<"cyclosm" | "thunderforest">("cyclosm");
  const probed = useRef(false);

  useEffect(() => {
    if (activeLayer !== "cycling" || probed.current) return;
    probed.current = true;

    const probeUrl = tileUrl.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0");

    fetch(probeUrl, { method: "HEAD" })
      .then((res) => {
        const source = res.headers.get("X-Tile-Source");
        if (source === "thunderforest") {
          setProvider("thunderforest");
        }
      })
      .catch(() => {});
  }, [activeLayer, tileUrl]);

  const attributions = useMemo(
    () => (provider === "thunderforest" ? THUNDERFOREST_ATTRIBUTIONS : CYCLOSM_ATTRIBUTIONS),
    [provider],
  );

  return (
    <RasterBaseLayer
      sourceId="openmapx-cyclosm-source"
      layerId="openmapx-cyclosm-layer"
      tiles={[tileUrl]}
      activeWhen="cycling"
      maxzoom={20}
      attributions={attributions}
      paint={{ "raster-opacity": 0.95 }}
    />
  );
}
