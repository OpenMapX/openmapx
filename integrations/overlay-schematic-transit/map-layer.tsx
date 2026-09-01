"use client";

import { useOverlayExclusion } from "@openmapx/core";
import { useMemo } from "react";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useIntegrationAttribution } from "@/integration-api/overlay/useIntegrationAttribution";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { buildSchematicGroup } from "./map-layer-group";
import { useSchematicTransitStore } from "./store";

export function SchematicTransitLayer() {
  const { apiUrl } = useEnv();
  const layerVisible = useSchematicTransitStore((s) => s.layerVisible);
  const network = useSchematicTransitStore((s) => s.network);
  const layout = useSchematicTransitStore((s) => s.layout);

  useOverlayExclusion("schematic-transit", layerVisible);
  useIntegrationAttribution("overlay-schematic-transit", layerVisible);

  const group = useMemo(
    () => (layerVisible ? buildSchematicGroup(apiUrl, network, layout) : null),
    [apiUrl, layerVisible, network, layout],
  );
  useMapLayerGroup(group);

  return null;
}

export default SchematicTransitLayer;
