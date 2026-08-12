"use client";

import type * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import {
  buildEffisPopupModel,
  EFFIS_BURNED_AREA_STYLE,
  renderWildfirePopupModel,
  type WildfirePopupTranslate,
} from "../presentation";
import type { EffisProperties, WildfireFeatureCollection } from "../types";
import type { WildfirePopupController } from "./hotspot-layer";
import { usePolygonLayerLifecycle } from "./nifc-perimeter-layer";
import { useViewportWildfireSource } from "./use-viewport-wildfire-source";

export const EFFIS_SOURCE = "openmapx-wildfires-effis-source";
export const EFFIS_FILL = "openmapx-wildfires-effis-fill";
export const EFFIS_LINE = "openmapx-wildfires-effis-line";

const EMPTY_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const EFFIS_FILL_PAINT: Extract<maplibregl.AddLayerObject, { type: "fill" }>["paint"] = {
  "fill-color": EFFIS_BURNED_AREA_STYLE.fillColor,
  "fill-opacity": EFFIS_BURNED_AREA_STYLE.fillOpacity,
};

const EFFIS_LINE_PAINT: Extract<maplibregl.AddLayerObject, { type: "line" }>["paint"] = {
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
  const bridge = useGeoJsonSourceDataBridge({
    mapRef: mapContext.mapRef,
    mapReady: mapContext.mapReady,
    styleVersion: mapContext.styleVersion,
    visible: active,
  });
  const publish = useCallback(
    (data: WildfireFeatureCollection) => {
      bridge.publish([{ sourceId: EFFIS_SOURCE, data }]);
    },
    [bridge.publish],
  );
  const clear = useCallback(() => {
    bridge.reset([{ sourceId: EFFIS_SOURCE, data: EMPTY_COLLECTION }]);
  }, [bridge.reset]);
  const popupHtml = useCallback(
    (properties: Record<string, unknown>) => {
      if (properties.kind !== "satellite-burned-area" || properties.provider !== "effis") {
        return null;
      }
      return renderWildfirePopupModel(
        buildEffisPopupModel(properties as unknown as EffisProperties, locale),
        translate,
      );
    },
    [locale, translate],
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
    fillPaint: EFFIS_FILL_PAINT,
    linePaint: EFFIS_LINE_PAINT,
    popupController,
    popupHtml,
  });

  return null;
}
