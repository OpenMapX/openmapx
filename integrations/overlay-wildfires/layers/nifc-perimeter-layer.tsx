"use client";

import { captureHazardFeatures } from "@openmapx/integration-framework";
import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { EMPTY_FEATURE_COLLECTION } from "@/integration-api/map/mapLayerGroup";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useContributorResolver } from "@/integration-api/overlay/useContributorResolver";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import type { WildfirePopupController } from "../popup-controller";
import {
  buildNifcPopupModel,
  NIFC_PERIMETER_STYLE,
  type WildfirePopupTranslate,
} from "../presentation";
import type { NifcProperties, WildfireFeatureCollection } from "../types";
import { type FillPaint, type LinePaint, usePolygonLayerLifecycle } from "./polygon-layer";
import { useViewportWildfireSource } from "./use-viewport-wildfire-source";

export const NIFC_SOURCE = "openmapx-wildfires-nifc-source";
export const NIFC_FILL = "openmapx-wildfires-nifc-fill";
export const NIFC_LINE = "openmapx-wildfires-nifc-line";

export interface NifcPerimeterLayerProps {
  active: boolean;
  popupController: WildfirePopupController;
}

const NIFC_FILL_PAINT: FillPaint = {
  "fill-color": NIFC_PERIMETER_STYLE.fillColor,
  "fill-opacity": NIFC_PERIMETER_STYLE.fillOpacity,
};

const NIFC_LINE_PAINT: LinePaint = {
  "line-color": NIFC_PERIMETER_STYLE.lineColor,
  "line-width": NIFC_PERIMETER_STYLE.lineWidth,
};

export function NifcPerimeterLayer({ active, popupController }: NifcPerimeterLayerProps) {
  const mapContext = useMap();
  const env = useEnv();
  const locale = useLocale();
  const translate = useTranslations("wildfires") as WildfirePopupTranslate;
  const resolveContributors = useContributorResolver();
  useRenderedMapAttributions("wildfires-nifc", [NIFC_FILL, NIFC_LINE], active);
  const bridge = useGeoJsonSourceDataBridge({
    mapRef: mapContext.mapRef,
    mapReady: mapContext.mapReady,
    styleVersion: mapContext.styleVersion,
    visible: active,
  });
  const publish = useCallback(
    (data: WildfireFeatureCollection) => {
      const captured = captureHazardFeatures(data, resolveContributors, (feature) =>
        Array.isArray(feature.properties?.sources)
          ? feature.properties.sources
          : typeof feature.properties?.provider === "string"
            ? [feature.properties.provider]
            : [],
      );
      bridge.publish([{ sourceId: NIFC_SOURCE, data: captured }]);
    },
    [bridge.publish, resolveContributors],
  );
  const clear = useCallback(() => {
    bridge.reset([{ sourceId: NIFC_SOURCE, data: EMPTY_FEATURE_COLLECTION }]);
  }, [bridge.reset]);
  const popupModel = useCallback(
    (properties: Record<string, unknown>) =>
      properties.kind === "reported-perimeter"
        ? buildNifcPopupModel(properties as unknown as NifcProperties, locale)
        : null,
    [locale],
  );

  const aboveMinZoom = useViewportWildfireSource({
    active,
    sourceId: "nifc",
    endpoint: `${env.apiUrl}/api/integrations/overlay-wildfires/perimeters/nifc`,
    minZoom: 3,
    refreshMs: 300_000,
    publish,
    clear,
  });
  usePolygonLayerLifecycle({
    active: active && aboveMinZoom,
    sourceId: NIFC_SOURCE,
    fillId: NIFC_FILL,
    lineId: NIFC_LINE,
    fillOrder: 20,
    lineOrder: 21,
    minZoom: 3,
    fillPaint: NIFC_FILL_PAINT,
    linePaint: NIFC_LINE_PAINT,
    popupController,
    popupModel,
    translate,
  });

  return null;
}
