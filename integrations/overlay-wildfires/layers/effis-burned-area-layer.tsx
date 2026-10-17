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
  buildEffisPopupModel,
  EFFIS_BURNED_AREA_STYLE,
  type WildfirePopupTranslate,
} from "../presentation";
import type { EffisProperties, WildfireFeatureCollection } from "../types";
import { type FillPaint, type LinePaint, usePolygonLayerLifecycle } from "./polygon-layer";
import { useViewportWildfireSource } from "./use-viewport-wildfire-source";

export const EFFIS_SOURCE = "openmapx-wildfires-effis-source";
export const EFFIS_FILL = "openmapx-wildfires-effis-fill";
export const EFFIS_LINE = "openmapx-wildfires-effis-line";

const EFFIS_FILL_PAINT: FillPaint = {
  "fill-color": EFFIS_BURNED_AREA_STYLE.fillColor,
  "fill-opacity": EFFIS_BURNED_AREA_STYLE.fillOpacity,
};

const EFFIS_LINE_PAINT: LinePaint = {
  "line-color": EFFIS_BURNED_AREA_STYLE.lineColor,
  "line-width": EFFIS_BURNED_AREA_STYLE.lineWidth,
  "line-dasharray": EFFIS_BURNED_AREA_STYLE.lineDasharray,
};

export interface EffisBurnedAreaLayerProps {
  active: boolean;
  popupController: WildfirePopupController;
}

export function EffisBurnedAreaLayer({ active, popupController }: EffisBurnedAreaLayerProps) {
  const mapContext = useMap();
  const env = useEnv();
  const locale = useLocale();
  const translate = useTranslations("wildfires") as WildfirePopupTranslate;
  const resolveContributors = useContributorResolver();
  useRenderedMapAttributions("wildfires-effis", [EFFIS_FILL, EFFIS_LINE], active);
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
      bridge.publish([{ sourceId: EFFIS_SOURCE, data: captured }]);
    },
    [bridge.publish, resolveContributors],
  );
  const clear = useCallback(() => {
    bridge.reset([{ sourceId: EFFIS_SOURCE, data: EMPTY_FEATURE_COLLECTION }]);
  }, [bridge.reset]);
  const popupModel = useCallback(
    (properties: Record<string, unknown>) =>
      properties.kind === "satellite-burned-area"
        ? buildEffisPopupModel(properties as unknown as EffisProperties, locale)
        : null,
    [locale],
  );

  const aboveMinZoom = useViewportWildfireSource({
    active,
    sourceId: "effis",
    endpoint: `${env.apiUrl}/api/integrations/overlay-wildfires/burned-areas/effis`,
    minZoom: 3,
    refreshMs: 1_800_000,
    publish,
    clear,
  });
  usePolygonLayerLifecycle({
    active: active && aboveMinZoom,
    sourceId: EFFIS_SOURCE,
    fillId: EFFIS_FILL,
    lineId: EFFIS_LINE,
    fillOrder: 10,
    lineOrder: 11,
    minZoom: 3,
    fillPaint: EFFIS_FILL_PAINT,
    linePaint: EFFIS_LINE_PAINT,
    popupController,
    popupModel,
    translate,
  });

  return null;
}
