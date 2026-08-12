"use client";

import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import {
  buildNifcPopupModel,
  NIFC_PERIMETER_STYLE,
  renderWildfirePopupModel,
  type WildfirePopupTranslate,
} from "../presentation";
import type { NifcProperties, WildfireFeatureCollection } from "../types";
import type { WildfirePopupController } from "./hotspot-layer";
import { useViewportWildfireSource } from "./use-viewport-wildfire-source";

export const NIFC_SOURCE = "openmapx-wildfires-nifc-source";
export const NIFC_FILL = "openmapx-wildfires-nifc-fill";
export const NIFC_LINE = "openmapx-wildfires-nifc-line";

const EMPTY_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export interface NifcPerimeterLayerProps {
  active: boolean;
  popupController: WildfirePopupController;
}

interface PolygonLayerLifecycleOptions {
  active: boolean;
  sourceId: string;
  fillId: string;
  lineId: string;
  fillOrder: number;
  lineOrder: number;
  fillPaint: Extract<maplibregl.AddLayerObject, { type: "fill" }>["paint"];
  linePaint: Extract<maplibregl.AddLayerObject, { type: "line" }>["paint"];
  popupController: WildfirePopupController;
  popupHtml(properties: Record<string, unknown>): string | null;
}

/** Shared MapLibre lifecycle for the two viewport-backed polygon components. */
export function usePolygonLayerLifecycle({
  active,
  sourceId,
  fillId,
  lineId,
  fillOrder,
  lineOrder,
  fillPaint,
  linePaint,
  popupController,
  popupHtml,
}: PolygonLayerLifecycleOptions): void {
  const { mapRef, mapReady, styleVersion } = useMap();

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const remove = () => {
      try {
        if (map.getLayer(lineId)) map.removeLayer(lineId);
        if (map.getLayer(fillId)) map.removeLayer(fillId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      } catch {
        // MapLibre may be replacing the style while cleanup runs.
      }
      unregisterLayerSlot(fillId);
      unregisterLayerSlot(lineId);
    };

    const sync = () => {
      if (!active) {
        remove();
        popupController.close();
        return;
      }
      try {
        if (!map.getSource(sourceId)) {
          map.addSource(sourceId, { type: "geojson", data: EMPTY_COLLECTION });
        }
        if (!map.getLayer(fillId)) {
          addLayerInSlot(
            map,
            {
              id: fillId,
              type: "fill",
              source: sourceId,
              minzoom: 3,
              paint: fillPaint,
            },
            "area-overlays",
            fillOrder,
          );
        }
        if (!map.getLayer(lineId)) {
          addLayerInSlot(
            map,
            {
              id: lineId,
              type: "line",
              source: sourceId,
              minzoom: 3,
              paint: linePaint,
            },
            "area-overlays",
            lineOrder,
          );
        }
      } catch {
        // A subsequent styledata event retries once the new style is ready.
      }
    };

    sync();
    if (!active) return;
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
      remove();
      popupController.close();
    };
  }, [
    active,
    fillId,
    fillOrder,
    fillPaint,
    lineId,
    lineOrder,
    linePaint,
    mapReady,
    mapRef,
    popupController,
    sourceId,
    styleVersion,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;

    const onClick = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const html = popupHtml(feature.properties as Record<string, unknown>);
      if (!html) return;
      popupController.open(
        new maplibregl.Popup({
          closeButton: true,
          maxWidth: "320px",
          className: "omx-popup",
        })
          .setLngLat(event.lngLat)
          .setHTML(html)
          .addTo(map),
      );
    };
    const onMouseEnter = () => {
      map.getCanvasContainer().style.cursor = "pointer";
    };
    const onMouseLeave = () => {
      map.getCanvasContainer().style.cursor = "";
    };

    for (const layerId of [fillId, lineId]) {
      INTERACTIVE_LAYER_IDS.add(layerId);
      map.on("click", layerId, onClick);
      map.on("mouseenter", layerId, onMouseEnter);
      map.on("mouseleave", layerId, onMouseLeave);
    }
    return () => {
      for (const layerId of [fillId, lineId]) {
        map.off("click", layerId, onClick);
        map.off("mouseenter", layerId, onMouseEnter);
        map.off("mouseleave", layerId, onMouseLeave);
        INTERACTIVE_LAYER_IDS.delete(layerId);
      }
      map.getCanvasContainer().style.cursor = "";
      popupController.close();
    };
  }, [active, fillId, lineId, mapReady, mapRef, popupController, popupHtml]);
}

const NIFC_FILL_PAINT: Extract<maplibregl.AddLayerObject, { type: "fill" }>["paint"] = {
  "fill-color": NIFC_PERIMETER_STYLE.fillColor,
  "fill-opacity": NIFC_PERIMETER_STYLE.fillOpacity,
};

const NIFC_LINE_PAINT: Extract<maplibregl.AddLayerObject, { type: "line" }>["paint"] = {
  "line-color": NIFC_PERIMETER_STYLE.lineColor,
  "line-width": NIFC_PERIMETER_STYLE.lineWidth,
};

export function NifcPerimeterLayer({ active, popupController }: NifcPerimeterLayerProps) {
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
      bridge.publish([{ sourceId: NIFC_SOURCE, data }]);
    },
    [bridge.publish],
  );
  const clear = useCallback(() => {
    bridge.reset([{ sourceId: NIFC_SOURCE, data: EMPTY_COLLECTION }]);
  }, [bridge.reset]);
  const popupHtml = useCallback(
    (properties: Record<string, unknown>) => {
      if (properties.kind !== "reported-perimeter" || properties.provider !== "nifc") return null;
      return renderWildfirePopupModel(
        buildNifcPopupModel(properties as unknown as NifcProperties, locale),
        translate,
      );
    },
    [locale, translate],
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
    fillPaint: NIFC_FILL_PAINT,
    linePaint: NIFC_LINE_PAINT,
    popupController,
    popupHtml,
  });

  return null;
}
