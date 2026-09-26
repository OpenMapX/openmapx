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
  descriptionKey?: string;
}

export type DetailGroupId = "transport" | "outdoors" | "weatherEnvironment" | "otherDetails";

export interface DetailGroup {
  id: DetailGroupId;
  entries: GeneratedLayerEntry[];
}

const DETAIL_GROUPS: readonly DetailGroupId[] = [
  "transport",
  "outdoors",
  "weatherEnvironment",
  "otherDetails",
];

const DETAIL_PURPOSE: Record<string, DetailGroupId> = {
  "traffic-flow": "transport",
  traffic: "transport",
  "road-conditions": "transport",
  transit: "transport",
  "live-transit": "transport",
  "schematic-transit": "transport",
  cycling: "transport",
  ourairports: "transport",
  nautical: "transport",
  hiking: "outdoors",
  "winter-sports": "outdoors",
  "street-level-imagery": "outdoors",
  satellite: "outdoors",
  "3d-buildings": "outdoors",
  "air-quality": "weatherEnvironment",
  environment: "weatherEnvironment",
  weather: "weatherEnvironment",
  "weather-alerts": "weatherEnvironment",
  wildfires: "weatherEnvironment",
  earthquakes: "weatherEnvironment",
  "natural-events": "weatherEnvironment",
  "sun-time": "weatherEnvironment",
};

const DETAIL_DESCRIPTIONS: Record<string, string> = {
  "traffic-flow": "trafficFlowDescription",
  traffic: "trafficTomtomDescription",
  "road-conditions": "trafficIncidentsDescription",
};

/** Overlay ID mapping: integration IDs like "overlay-earthquakes" → overlay IDs like "earthquakes" */
function integrationIdToOverlayId(integrationId: string): string {
  if (integrationId === "overlay-traffic-tomtom") return "traffic";
  // Every street-level imagery provider shares a single overlay toggle and exclusion group.
  if (integrationId.startsWith("street-level-imagery-")) return "street-level-imagery";
  return integrationId.replace(/^overlay-/, "").replace(/^tool-/, "");
}

export function useLayerSelectorConfig() {
  const registry = useIntegrationRegistry();

  return useMemo(() => {
    const withLayerSelector = registry.getWithLayerSelector();

    const mapDetails: GeneratedLayerEntry[] = [];
    const mapTools: GeneratedLayerEntry[] = [];
    const quickDetails: GeneratedLayerEntry[] = [];

    // Several integrations can back one overlay (street-level imagery is served
    // by Panoramax, Mapillary and others). They must yield a single toggle —
    // entries are keyed by overlay id, so duplicates would also collide on the
    // React key. First in registry order wins, so provider priority decides.
    const claimedOverlayIds = new Set<string>();

    for (const integration of withLayerSelector) {
      const ls = integration.frontend?.layerSelector;
      if (!ls) continue;
      const overlayId = integrationIdToOverlayId(integration.id);
      if (claimedOverlayIds.has(overlayId)) continue;
      claimedOverlayIds.add(overlayId);
      const iconName = ls.icon;
      const entry: GeneratedLayerEntry = {
        id: overlayId,
        labelKey: ls.labelKey,
        overlayId,
        serviceId: integration.id,
        descriptionKey: DETAIL_DESCRIPTIONS[overlayId],
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

    const detailGroups: DetailGroup[] = DETAIL_GROUPS.map((id) => ({
      id,
      entries: mapDetails.filter(
        (entry) => (DETAIL_PURPOSE[entry.overlayId] ?? "otherDetails") === id,
      ),
    })).filter((group) => group.entries.length > 0);

    return { mapDetails, mapTools, quickDetails, detailGroups };
  }, [registry]);
}
