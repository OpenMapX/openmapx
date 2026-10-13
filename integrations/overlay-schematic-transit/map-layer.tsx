"use client";

import { useOverlayExclusion } from "@openmapx/core";
import { dataSourceToAttribution } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { useMemo, useRef } from "react";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { buildSchematicGroup } from "./map-layer-group";
import { useSchematicTransitStore } from "./store";

export function SchematicTransitLayer() {
  const { apiUrl } = useEnv();
  const layerVisible = useSchematicTransitStore((s) => s.layerVisible);
  const network = useSchematicTransitStore((s) => s.network);
  const layout = useSchematicTransitStore((s) => s.layout);

  useOverlayExclusion("schematic-transit", layerVisible);
  const registry = useIntegrationRegistry();
  const snapshots = useRef(new Map<string, readonly Attribution[]>());
  const key = `${apiUrl}/${network}/${layout}`;
  if (layerVisible && !snapshots.current.has(key)) {
    const source = registry.findDataSource("loom-tiles");
    snapshots.current.set(
      key,
      snapshotContributors(source ? [dataSourceToAttribution(source)] : []),
    );
  }
  const contributors = snapshots.current.get(key) ?? [];

  const group = useMemo(
    () => (layerVisible ? buildSchematicGroup(apiUrl, network, layout) : null),
    [apiUrl, layerVisible, network, layout],
  );
  useMapLayerGroup(group);
  useRenderedMapAttributions(
    "schematic-transit",
    group?.layers.map((layer) => layer.id) ?? [],
    layerVisible,
    {
      layerContributors: Object.fromEntries(
        group?.layers.map((layer) => [layer.id, contributors]) ?? [],
      ),
    },
  );

  return null;
}

export default SchematicTransitLayer;
