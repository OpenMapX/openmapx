"use client";

import type { AlongRoutePoi, CategoryPlace } from "@openmapx/core";
import {
  contributorsForField,
  readCapturedContributors,
  serializeContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type * as maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  brandImageId,
  loadBrandMarkerImage,
  loadedBrandMarkerContributors,
} from "@/components/map/CategoryResultMarkers";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapOverlayInteraction } from "@/integration-api/map/useMapOverlayInteraction";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { BRAND_HEX } from "@/integration-api/runtime/theme";
import { createMarkerSvg } from "@/lib/markerSvg";
import { routeStopCopy } from "@/lib/navigation/routeStopCopy";

const SOURCE = "route-search-source";
const LAYER = "route-search-layer";
const LABEL_LAYER = "route-search-labels";
/**
 * Results the user asked for win over ambient overlays drawn beneath them.
 * Along-route results draw above the category and data-source results.
 */
const HOST_RESULT_PRIORITY = 203;

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
  const { mapRef, styleVersion } = useMap();
  const t = useTranslations("navigation");
  useRenderedMapAttributions("route-search", [LAYER, LABEL_LAYER], true, {
    resolveFeatureContributors: (feature) => {
      const label = feature.layer.id === LABEL_LAYER;
      const captured =
        readCapturedContributors(
          feature.properties?.[label ? "_mapLabelAttributions" : "_mapMarkerAttributions"],
        ) ?? [];
      const qid = feature.properties?._mapBrandQid;
      // A shared same-QID image may be replaced after this feature was published.
      // Credit the captured file installed now, while coordinates stay feature-bound.
      return !label && mapRef.current && typeof qid === "string" && qid
        ? snapshotContributors(captured, loadedBrandMarkerContributors(mapRef.current, qid))
        : captured;
    },
  });
  const fallbackImageId = `route-search-pin-${categoryKey}`;
  // The brand logo loads asynchronously, and a style switch drops it with every
  // other image. Each finished load re-renders, and the pins use the logo
  // whenever the current style holds it.
  const [brandLoads, setBrandLoads] = useState(0);
  const imageId = useMemo(() => {
    void brandLoads;
    void styleVersion;
    const map = mapRef.current;
    return brandQid && map?.hasImage(brandImageId(brandQid))
      ? brandImageId(brandQid)
      : fallbackImageId;
  }, [brandLoads, styleVersion, mapRef, brandQid, fallbackImageId]);
  const data = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: results.map((poi) => {
        const copy = routeStopCopy(poi, true);
        const coordinateReceipts = contributorsForField(poi.place, "coordinates");
        const durationReceipts =
          poi.detour?.kind === "network" ? contributorsForField(poi.detour, "seconds") : [];
        return {
          type: "Feature" as const,
          properties: {
            id: poi.place.id,
            imageId,
            label: t(copy.key, copy.values),
            _mapBrandQid: imageId === fallbackImageId ? "" : (brandQid ?? ""),
            _mapMarkerAttributions: serializeContributors(coordinateReceipts),
            _mapLabelAttributions: serializeContributors(
              snapshotContributors(coordinateReceipts, durationReceipts),
            ),
          },
          geometry: { type: "Point" as const, coordinates: poi.place.coordinates },
        };
      }),
    }),
    [brandQid, fallbackImageId, imageId, results, t],
  );

  // A brand logo that finishes loading after the layer unmounted, or for a
  // brand the search no longer shows, must not reach the map.
  const mounted = useRef(true);
  const currentBrand = useRef(brandQid);
  useEffect(() => {
    currentBrand.current = brandQid;
  }, [brandQid]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const group = useMemo<MapLayerGroup>(
    () => ({
      sources: { [SOURCE]: { type: "geojson", data } },
      images: {
        [fallbackImageId]: (map) =>
          ensurePinImage(
            map,
            fallbackImageId,
            iconPath,
            () => mounted.current && mapRef.current === map,
          ),
        ...(brandQid
          ? {
              [brandImageId(brandQid)]: (map: maplibregl.Map) => {
                const isCurrent = () =>
                  mounted.current && mapRef.current === map && currentBrand.current === brandQid;
                void loadBrandMarkerImage(map, brandQid, isCurrent).then((loaded) => {
                  if (loaded && isCurrent()) setBrandLoads((count) => count + 1);
                });
              },
            }
          : {}),
      },
      // These are the user's active "along the route" results, so they sit with
      // the route's own waypoint pins, above everything else.
      layers: [
        {
          id: LAYER,
          type: "symbol",
          source: SOURCE,
          layout: {
            "icon-image": ["get", "imageId"],
            "icon-size": 0.55,
            "icon-allow-overlap": true,
            "icon-anchor": "bottom",
          },
          slot: "route-markers",
          order: 23,
        },
        {
          id: LABEL_LAYER,
          type: "symbol",
          source: SOURCE,
          layout: {
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-offset": [0, 0.5],
            "text-anchor": "top",
            "text-optional": true,
          },
          paint: { "text-color": "#202124", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
          slot: "route-markers",
          order: 24,
        },
      ],
    }),
    [data, fallbackImageId, iconPath, brandQid, mapRef],
  );
  useMapLayerGroup(group);

  // Taps on a pin belong to it: the plain-map click handler, base-map POI taps
  // and the directions route line all skip the layers registered here.
  useMapOverlayInteraction({
    id: "route-search-results",
    layerIds: [LAYER, LABEL_LAYER],
    priority: HOST_RESULT_PRIORITY,
    onClick: ({ features }) => {
      const id = features[0]?.properties?.id;
      const hit = results.find((r) => r.place.id === id);
      if (hit) onSelect(hit);
    },
  });

  return null;
}
