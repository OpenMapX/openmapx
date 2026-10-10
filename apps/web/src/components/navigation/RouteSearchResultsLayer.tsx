"use client";

import type { AlongRoutePoi, CategoryPlace } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { brandImageId, loadBrandMarkerImage } from "@/components/map/CategoryResultMarkers";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { BRAND_HEX } from "@/integration-api/runtime/theme";
import { createMarkerSvg } from "@/lib/markerSvg";
import { routeStopCopy } from "@/lib/navigation/routeStopCopy";

const SOURCE = "route-search-source";
const LAYER = "route-search-layer";

function ensurePinImage(
  map: maplibregl.Map,
  id: string,
  iconPath: string,
  isCurrent: () => boolean,
): void {
  if (map.hasImage(id) || !iconPath) return;
  const svg = createMarkerSvg(iconPath, BRAND_HEX, 56);
  const img = new Image(56, 56);
  img.onload = () => {
    if (isCurrent() && !map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
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
  brandQid,
  onSelect,
}: {
  results: AlongRoutePoi<CategoryPlace>[];
  iconPath: string;
  categoryKey: string;
  brandQid?: string;
  onSelect: (poi: AlongRoutePoi<CategoryPlace>) => void;
}) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const t = useTranslations("navigation");
  const fallbackImageId = `route-search-pin-${categoryKey}`;
  const [loadedBrand, setLoadedBrand] = useState<{ qid: string; styleVersion: number } | null>(
    null,
  );
  const imageId =
    loadedBrand?.qid === brandQid && loadedBrand?.styleVersion === styleVersion
      ? brandImageId(loadedBrand.qid)
      : fallbackImageId;
  const { publish: publishGeoJson } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: true,
  });

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
      23,
    );
  }, [mapRef, mapReady, styleVersion]);

  useEffect(() => {
    void styleVersion; // re-register the image after a style swap clears it
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let active = true;
    const source = map.getSource(SOURCE);
    const isCurrent = () => active && mapRef.current === map && map.getSource(SOURCE) === source;
    ensurePinImage(map, fallbackImageId, iconPath, isCurrent);
    if (brandQid) {
      void loadBrandMarkerImage(map, brandQid, isCurrent).then((loaded) => {
        if (loaded && isCurrent()) setLoadedBrand({ qid: brandQid, styleVersion });
      });
    }
    return () => {
      active = false;
    };
  }, [mapRef, mapReady, styleVersion, fallbackImageId, iconPath, brandQid]);

  useEffect(() => {
    void styleVersion; // re-populate after the source is recreated on a style swap
    publishGeoJson([
      {
        sourceId: SOURCE,
        data: {
          type: "FeatureCollection",
          features: results.map((poi) => {
            const copy = routeStopCopy(poi, true);
            return {
              type: "Feature" as const,
              properties: {
                id: poi.place.id,
                imageId,
                label: t(copy.key, copy.values),
              },
              geometry: { type: "Point" as const, coordinates: poi.place.coordinates },
            };
          }),
        },
      },
    ]);
  }, [imageId, publishGeoJson, results, styleVersion, t]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
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
      publishGeoJson([{ sourceId: SOURCE, data: { type: "FeatureCollection", features: [] } }]);
    };
  }, [publishGeoJson]);

  return null;
}
