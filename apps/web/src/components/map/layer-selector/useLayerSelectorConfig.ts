"use client";

import { useIntegrationRegistry } from "@openmapx/core";
import { useMemo } from "react";
import { genericPreview, INTEGRATION_PREVIEWS } from "./integrationPreviews";

export interface GeneratedLayerEntry {
  id: string;
  labelKey: string;
  overlayId: string;
  preview: React.ReactNode;
  serviceId?: string;
}

/** Overlay ID mapping: integration IDs like "overlay-earthquakes" → overlay IDs like "earthquakes" */
function integrationIdToOverlayId(integrationId: string): string {
  // Specific mappings must come before generic prefix stripping
  if (integrationId === "overlay-traffic-tomtom") return "traffic";
  if (integrationId === "street-view-mapillary") return "street-view";
  return integrationId.replace(/^overlay-/, "").replace(/^tool-/, "");
}

export function useLayerSelectorConfig() {
  const registry = useIntegrationRegistry();

  return useMemo(() => {
    const withLayerSelector = registry.getWithLayerSelector();

    const mapDetails: GeneratedLayerEntry[] = [];
    const mapTools: GeneratedLayerEntry[] = [];

    for (const integration of withLayerSelector) {
      const ls = integration.frontend?.layerSelector;
      if (!ls) continue;
      const overlayId = integrationIdToOverlayId(integration.id);
      const entry: GeneratedLayerEntry = {
        id: overlayId,
        labelKey: ls.labelKey,
        overlayId,
        serviceId: integration.id,
        preview: INTEGRATION_PREVIEWS[overlayId] ?? genericPreview,
      };

      if (ls.group === "map-details") {
        mapDetails.push(entry);
      } else if (ls.group === "map-tools") {
        mapTools.push(entry);
      }
    }

    return { mapDetails, mapTools };
  }, [registry]);
}
