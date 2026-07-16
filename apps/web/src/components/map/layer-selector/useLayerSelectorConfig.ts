"use client";

import Icon from "@mui/material/Icon";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { createElement, type ReactNode, useMemo } from "react";
import { genericPreview, IntegrationLayerPreview } from "./IntegrationLayerPreview";

export interface GeneratedLayerEntry {
  id: string;
  labelKey: string;
  overlayId: string;
  preview: ReactNode;
  icon: ReactNode;
  serviceId?: string;
}

/** Overlay ID mapping: integration IDs like "overlay-earthquakes" → overlay IDs like "earthquakes" */
function integrationIdToOverlayId(integrationId: string): string {
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
    const quickDetails: GeneratedLayerEntry[] = [];

    for (const integration of withLayerSelector) {
      const ls = integration.frontend?.layerSelector;
      if (!ls) continue;
      const overlayId = integrationIdToOverlayId(integration.id);
      const iconName = ls.icon;
      const entry: GeneratedLayerEntry = {
        id: overlayId,
        labelKey: ls.labelKey,
        overlayId,
        serviceId: integration.id,
        preview:
          typeof ls.preview === "string" && ls.preview.length > 0
            ? createElement(IntegrationLayerPreview, {
                key: integration.id,
                integrationId: integration.id,
              })
            : genericPreview,
        icon: iconName
          ? createElement(Icon, { sx: { fontSize: 14 } }, iconName)
          : createElement(Icon, { sx: { fontSize: 14 } }, "layers"),
      };

      if (ls.group === "map-details") {
        mapDetails.push(entry);
        if (ls.quickSelector) {
          quickDetails.push(entry);
        }
      } else if (ls.group === "map-tools") {
        mapTools.push(entry);
      }
    }

    return { mapDetails, mapTools, quickDetails };
  }, [registry]);
}
