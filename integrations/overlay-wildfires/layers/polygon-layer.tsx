"use client";

import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { EMPTY_FEATURE_COLLECTION, type MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import type { WildfirePopupController, WildfirePopupLease } from "../popup-controller";
import {
  renderWildfirePopupModel as buildPopupCard,
  type WildfirePopupModel,
  type WildfirePopupTranslate,
} from "../presentation";

export type FillPaint = Extract<maplibregl.AddLayerObject, { type: "fill" }>["paint"];
export type LinePaint = Extract<maplibregl.AddLayerObject, { type: "line" }>["paint"];

interface PolygonLayerOptions {
  sourceId: string;
  fillId: string;
  lineId: string;
  fillOrder: number;
  lineOrder: number;
  /** Lowest zoom the polygons draw at; unset draws them at every zoom. */
  minZoom?: number;
  fillPaint: FillPaint;
  linePaint: LinePaint;
}

interface PolygonLayerLifecycleOptions extends PolygonLayerOptions {
  active: boolean;
  popupController: WildfirePopupController;
  /** The popup for a clicked feature, or null when it shows none. */
  popupModel(properties: Record<string, unknown>): WildfirePopupModel | null;
  translate: WildfirePopupTranslate;
}

function polygonGroup({
  sourceId,
  fillId,
  lineId,
  fillOrder,
  lineOrder,
  minZoom,
  fillPaint,
  linePaint,
}: PolygonLayerOptions): MapLayerGroup {
  const zoomRange = minZoom === undefined ? {} : { minzoom: minZoom };
  return {
    sources: { [sourceId]: { type: "geojson", data: EMPTY_FEATURE_COLLECTION } },
    layers: [
      {
        id: fillId,
        type: "fill",
        source: sourceId,
        ...zoomRange,
        paint: fillPaint,
        slot: "area-overlays",
        order: fillOrder,
      },
      {
        id: lineId,
        type: "line",
        source: sourceId,
        ...zoomRange,
        paint: linePaint,
        slot: "area-overlays",
        order: lineOrder,
      },
    ],
  };
}

/** Shared MapLibre lifecycle for the GeoJSON-backed wildfire polygon components. */
export function usePolygonLayerLifecycle({
  active,
  sourceId,
  fillId,
  lineId,
  fillOrder,
  lineOrder,
  minZoom,
  fillPaint,
  linePaint,
  popupController,
  popupModel,
  translate,
}: PolygonLayerLifecycleOptions): void {
  const { mapRef, mapReady } = useMap();
  const popupLease = useRef<WildfirePopupLease>({});

  useMapLayerGroup(
    useMemo(
      () =>
        active
          ? polygonGroup({
              sourceId,
              fillId,
              lineId,
              fillOrder,
              lineOrder,
              minZoom,
              fillPaint,
              linePaint,
            })
          : null,
      [active, sourceId, fillId, lineId, fillOrder, lineOrder, minZoom, fillPaint, linePaint],
    ),
  );

  // Removing the polygons closes the popup one of them opened.
  useEffect(() => {
    if (!active) return;
    const lease = popupLease.current;
    return () => popupController.close(lease);
  }, [active, popupController]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;

    const onClick = (event: MapLayerMouseEvent) => {
      if (getMapClickOwner(event)) return;
      const feature = event.features?.[0];
      if (!feature) return;
      const model = popupModel(feature.properties as Record<string, unknown>);
      if (!model) return;
      popupController.open(
        popupLease.current,
        new maplibregl.Popup({
          closeButton: true,
          maxWidth: "320px",
          className: "omx-popup",
        })
          .setLngLat(event.lngLat)
          .setHTML(buildPopupCard(model, translate))
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
    };
  }, [active, fillId, lineId, mapReady, mapRef, popupController, popupModel, translate]);
}
