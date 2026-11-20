"use client";

import type { MapGeoJSONFeature, Popup } from "maplibre-gl";
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
  /** Features under the pointer while this overlay owns the hover, then `null`. */
  onHover?: (features: MapGeoJSONFeature[] | null) => void;
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
  enabled = true,
}: MapOverlayInteractionOptions): void {
  const { mapRef, mapReady } = useMap();
  const click = useEffectEvent((event: MapOverlayInteractionEvent) => onClick?.(event));
  const hover = useEffectEvent((features: MapGeoJSONFeature[] | null) => onHover?.(features));
  const hasClick = onClick !== undefined;
  const hasHover = onHover !== undefined;
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
    });
  }, [mapRef, mapReady, enabled, id, layerKey, priority, hasClick, hasHover]);
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
