"use client";

import type { AlongRoutePoi, CategoryPlace } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { addLayerInSlot } from "@/components/map/layers/layerStack";
import { useMap } from "@/lib/MapContext";
import { createMarkerSvg } from "@/lib/markerSvg";
import { BRAND_HEX } from "@/lib/theme";

const SOURCE = "route-search-source";
const LAYER = "route-search-layer";

function ensurePinImage(map: maplibregl.Map, id: string, iconPath: string): void {
  if (map.hasImage(id) || !iconPath) return;
  const svg = createMarkerSvg(iconPath, BRAND_HEX, 56);
  const img = new Image(56, 56);
  img.onload = () => {
    if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Pins for the "search along route" results, each labelled with the estimated
 * detour ("+N min"). Reuses the shared circular marker SVG with the category's
 * own icon. Tapping a pin selects it. Mirrors the hook→layer pattern of
 * NavTrafficSignalsLayer.
 */
export function RouteSearchResultsLayer({
  results,
  iconPath,
  categoryKey,
  onSelect,
}: {
  results: AlongRoutePoi<CategoryPlace>[];
  iconPath: string;
  categoryKey: string;
  onSelect: (poi: AlongRoutePoi<CategoryPlace>) => void;
}) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const imageId = `route-search-pin-${categoryKey}`;

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || map.getSource(SOURCE)) return;
    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    // Appended with no `beforeId` before this migration, so it already sat
    // above everything (including base labels) — `route-markers` keeps that
    // depth: these are the user's active "along the route" search results,
    // the same "current task on the map" reasoning as the route's own
    // waypoint pins.
    addLayerInSlot(
      map,
      {
        id: LAYER,
        type: "symbol",
        source: SOURCE,
        layout: {
          "icon-image": ["get", "imageId"],
          "icon-size": 0.55,
          "icon-allow-overlap": true,
          "icon-anchor": "bottom",
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, 0.5],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: { "text-color": "#202124", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
      },
      "route-markers",
      22,
    );
  }, [mapRef, mapReady, styleVersion]);

  useEffect(() => {
    void styleVersion; // re-register the image after a style swap clears it
    const map = mapRef.current;
    if (map && mapReady) ensurePinImage(map, imageId, iconPath);
  }, [mapRef, mapReady, styleVersion, imageId, iconPath]);

  useEffect(() => {
    void styleVersion; // re-populate after the source is recreated on a style swap
    const raw = mapRef.current?.getSource(SOURCE);
    if (raw?.type !== "geojson") return;
    (raw as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: results.map((poi) => ({
        type: "Feature" as const,
        properties: {
          id: poi.place.id,
          imageId,
          label: `+${Math.max(1, Math.round(poi.detourSeconds / 60))} min`,
        },
        geometry: { type: "Point" as const, coordinates: poi.place.coordinates },
      })),
    });
  }, [mapRef, results, imageId, styleVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      const hit = results.find((r) => r.place.id === id);
      if (hit) onSelect(hit);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", LAYER, onClick);
    map.on("mouseenter", LAYER, onEnter);
    map.on("mouseleave", LAYER, onLeave);
    return () => {
      map.off("click", LAYER, onClick);
      map.off("mouseenter", LAYER, onEnter);
      map.off("mouseleave", LAYER, onLeave);
    };
  }, [mapRef, results, onSelect]);

  // Clear pins when the layer unmounts (search closed).
  useEffect(() => {
    return () => {
      const raw = mapRef.current?.getSource(SOURCE);
      if (raw && raw.type === "geojson") {
        (raw as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: [] });
      }
    };
  }, [mapRef]);

  return null;
}
