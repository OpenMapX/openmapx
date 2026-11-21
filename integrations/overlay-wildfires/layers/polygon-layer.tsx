"use client";

import * as maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { EMPTY_FEATURE_COLLECTION, type MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapOverlayInteraction } from "@/integration-api/map/useMapOverlayInteraction";
import type { WildfirePopupController, WildfirePopupLease } from "../popup-controller";
import {
  renderWildfirePopupModel,
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
  const { mapRef } = useMap();
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

  useMapOverlayInteraction({
    id: `overlay-wildfires-${fillId}`,
    layerIds: [fillId, lineId],
    priority: 20,
    enabled: active,
    onClick: ({ event, features }) => {
      const map = mapRef.current;
      const feature = features[0];
      if (!map || !feature) return;
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
          .setHTML(renderWildfirePopupModel(model, translate))
          .addTo(map),
      );
    },
  });
}
