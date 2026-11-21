"use client";

import type { MapGeoJSONFeature, MapMouseEvent, Point, Popup } from "maplibre-gl";
import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import {
  type MapOverlayInteractionEvent,
  registerMapOverlayInteraction,
  removeMapOverlayPopup,
  replaceMapOverlayPopup,
} from "./mapInteractionArbiter";

export interface MapOverlayInteractionOptions {
  /** Stable owner id; two mounted overlays must not share one. */
  id: string;
  /** The layers whose rendered features this overlay answers for. */
  layerIds: readonly string[];
  /** Larger values win when several overlays have a feature under the pointer. */
  priority: number;
  /** Opens what was clicked; without it the overlay only shows the pointer cursor. */
  onClick?: (event: MapOverlayInteractionEvent) => void;
  /**
   * On every pointer move: the features under the pointer when this overlay
   * owns the hover, otherwise `null`. The pointer event comes along while the
   * pointer is over the map.
   */
  onHover?: (features: MapGeoJSONFeature[] | null, event?: MapMouseEvent) => void;
  /**
   * Whether the overlay has content under the point, for content MapLibre
   * cannot query, such as a custom 3D layer. It replaces the rendered-feature
   * lookup on `layerIds`.
   */
  hitTest?: (point: Point) => boolean;
  /** Registers only while true, e.g. while the layers are drawn. Defaults to true. */
  enabled?: boolean;
}

/**
 * Answer clicks and hover on an overlay's layers through the map's one shared
 * pipeline. The arbiter decides which overlay owns a click and the pointer
 * cursor when layers overlap, so an overlay never registers its own `click` or
 * `mousemove` handler or writes the cursor itself.
 *
 * The registration survives style changes: hits are looked up by layer id at
 * event time, so a layer that is briefly gone during a style swap is simply not
 * hit. The handlers always see the latest render's values.
 */
export function useMapOverlayInteraction({
  id,
  layerIds,
  priority,
  onClick,
  onHover,
  hitTest,
  enabled = true,
}: MapOverlayInteractionOptions): void {
  const { mapRef, mapReady } = useMap();
  const click = useEffectEvent((event: MapOverlayInteractionEvent) => onClick?.(event));
  const hover = useEffectEvent((features: MapGeoJSONFeature[] | null, event?: MapMouseEvent) =>
    onHover?.(features, event),
  );
  const test = useEffectEvent((point: Point) => hitTest?.(point) ?? false);
  const hasClick = onClick !== undefined;
  const hasHover = onHover !== undefined;
  const hasHitTest = hitTest !== undefined;
  const layerKey = layerIds.join("\n");

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !enabled || !layerKey) return;
    return registerMapOverlayInteraction(map, {
      id,
      layerIds: layerKey.split("\n"),
      priority,
      ...(hasClick ? { onClick: click } : {}),
      ...(hasHover ? { onHover: hover } : {}),
      ...(hasHitTest ? { hitTest: test } : {}),
    });
  }, [mapRef, mapReady, enabled, id, layerKey, priority, hasClick, hasHover, hasHitTest]);
}

/**
 * The popup an overlay opens from its click handler. Opening one replaces any
 * other overlay's popup on the map, so two overlapping overlays never show two
 * cards. The popup closes when `open` turns false and when the overlay unmounts.
 */
export function useMapOverlayPopup(open = true): {
  show: (popup: Popup) => void;
  close: () => void;
} {
  const { mapRef } = useMap();
  const popupRef = useRef<Popup | null>(null);

  const show = useCallback(
    (popup: Popup) => {
      const map = mapRef.current;
      if (!map) return;
      popupRef.current = popup;
      replaceMapOverlayPopup(map, popup);
    },
    [mapRef],
  );
  const close = useCallback(() => {
    const map = mapRef.current;
    const popup = popupRef.current;
    popupRef.current = null;
    if (map && popup) removeMapOverlayPopup(map, popup);
  }, [mapRef]);

  useEffect(() => {
    if (!open) close();
  }, [open, close]);
  useEffect(() => close, [close]);

  return { show, close };
}
