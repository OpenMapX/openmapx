"use client";

import {
  PANEL,
  type SavedPlace,
  usePlaceStore,
  useSavedListPlaces,
  useSavedLists,
  useSavedPlacesStore,
  useSidebarStore,
} from "@openmapx/core";
import { savedPlaceContributors } from "@openmapx/core/saved-place-contributors";
import {
  readCapturedContributors,
  serializeContributors,
} from "@openmapx/mobility-core/contributors";
import type { Map as MaplibreMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePinMarker } from "@/hooks/usePinMarker";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapOverlayInteraction } from "@/integration-api/map/useMapOverlayInteraction";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { listMarkerIcon } from "@/lib/listIcon";
import { createMarkerSvg } from "@/lib/markerSvg";
import { openSavedPlace, savedPlaceToPlace } from "@/lib/openSavedPlace";
import { onHoverPinElement, withinHoverPinBox } from "../hoverPin";
import { resultMarkerLayers } from "../resultMarkerLayers";

const SOURCE_ID = "saved-places-source";
const LAYER_ID = "saved-places-layer";
const LABEL_LAYER_ID = "saved-places-labels";
const LAYERS = [LAYER_ID, LABEL_LAYER_ID];

/** Emoji need the browser's colour-emoji font rasterized before entering MapLibre's sprite atlas. */
export function loadListMarkerImage(
  map: MaplibreMap,
  imageId: string,
  icon: string | null,
  isCurrent: () => boolean,
) {
  const glyph = listMarkerIcon(icon);
  const img = new Image(64, 64);
  img.onload = () => {
    if (!isCurrent() || map.hasImage(imageId)) return;
    if ("emoji" in glyph) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      ctx.font = '32px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph.emoji, 32, 34, 40);
      map.addImage(imageId, ctx.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
    } else {
      map.addImage(imageId, img, { pixelRatio: 2 });
    }
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    createMarkerSvg("path" in glyph ? glyph.path : ""),
  )}`;
}

function projectSavedPlaces(places: readonly SavedPlace[], imageId: string) {
  let hasContributors = false;
  const features = places.map((place) => {
    const coordinates = savedPlaceContributors(place.fieldContributors, ["lat", "lng"]);
    const label = savedPlaceContributors(place.fieldContributors, ["lat", "lng", "name"]);
    hasContributors ||= label.length > 0;
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [place.lng, place.lat] },
      properties: {
        id: place.id,
        name: place.name,
        imageId,
        _mapAttributions: serializeContributors(coordinates),
        _mapLabelAttributions: serializeContributors(label),
      },
    };
  });
  return { hasContributors, data: { type: "FeatureCollection" as const, features } };
}

export function SavedPlacesLayer() {
  const { mapRef, flyTo } = useMap();
  const isPanelOpen = useSidebarStore((s) => s.activeSidebarId === PANEL.SAVED);
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const activeListId = isPanelOpen && selectedListId ? selectedListId : null;
  const { data: lists } = useSavedLists();
  const { data: places } = useSavedListPlaces(activeListId);
  const shown = activeListId !== null && places !== undefined && places.length > 0;
  const icon = lists?.find((list) => list.id === activeListId)?.icon ?? null;
  const imageId = `saved-list-marker-${encodeURIComponent(icon ?? "bookmark")}`;
  const [hovered, setHovered] = useState<{ listId: string; id: string } | null>(null);
  const hoverPlace =
    shown && hovered?.listId === activeListId
      ? (places.find((place) => place.id === hovered.id) ?? null)
      : null;
  const selectedId = useMemo(
    () =>
      shown && selectedPlace
        ? (places.find((place) => savedPlaceToPlace(place).id === selectedPlace.id)?.id ?? null)
        : null,
    [shown, selectedPlace, places],
  );
  const hoverPin = hoverPlace?.id === selectedId ? null : hoverPlace;
  const activateHoverPin = useCallback(() => {
    if (hoverPin) openSavedPlace(hoverPin, flyTo);
  }, [hoverPin, flyTo]);
  usePinMarker(
    hoverPin ? [hoverPin.lng, hoverPin.lat] : null,
    hoverPin?.name ?? "",
    true,
    undefined,
    hoverPin ? activateHoverPin : undefined,
    hoverPin ? savedPlaceContributors(hoverPin.fieldContributors, ["lat", "lng"]) : [],
    hoverPin ? savedPlaceContributors(hoverPin.fieldContributors, ["lat", "lng", "name"]) : [],
  );

  const projected = useMemo(
    () => (shown ? projectSavedPlaces(places, imageId) : null),
    [shown, places, imageId],
  );
  useRenderedMapAttributions("saved-places", LAYERS, Boolean(projected?.hasContributors), {
    resolveFeatureContributors: (feature) =>
      readCapturedContributors(
        feature.properties?.[
          feature.layer.id === LABEL_LAYER_ID ? "_mapLabelAttributions" : "_mapAttributions"
        ],
      ) ?? [],
  });
  const currentImage = useRef<string | null>(null);
  currentImage.current = shown ? imageId : null;
  useEffect(() => {
    currentImage.current = shown ? imageId : null;
    return () => {
      currentImage.current = null;
    };
  }, [shown, imageId]);
  const group = useMemo<MapLayerGroup | null>(() => {
    if (!projected) return null;
    return {
      sources: { [SOURCE_ID]: { type: "geojson", data: projected.data } },
      images: {
        [imageId]: (map) => {
          const style = map.style;
          loadListMarkerImage(
            map,
            imageId,
            icon,
            () => mapRef.current === map && map.style === style && currentImage.current === imageId,
          );
        },
      },
      layers: resultMarkerLayers(SOURCE_ID, LAYER_ID, LABEL_LAYER_ID).map((layer, i) => ({
        ...layer,
        slot: "route-markers",
        order: 5 + i,
        filter: ["!=", ["get", "id"], selectedId ?? ""],
        ...(layer.id === LABEL_LAYER_ID
          ? {
              paint: {
                ...layer.paint,
                "text-opacity": ["case", ["==", ["get", "id"], hoverPlace?.id ?? ""], 0, 1],
              },
            }
          : {}),
      })),
    };
  }, [projected, imageId, icon, mapRef, selectedId, hoverPlace?.id]);
  useMapLayerGroup(group);

  // Saved places sit with the route pins, above results and ambient overlays.
  useMapOverlayInteraction({
    id: "saved-places",
    layerIds: LAYERS,
    priority: 210,
    enabled: shown,
    onClick: ({ features }) => {
      const place = places?.find((candidate) => candidate.id === features[0]?.properties?.id);
      if (place) openSavedPlace(place, flyTo);
    },
    onHover: (features, event) => {
      if (onHoverPinElement(event)) return;
      const place = features
        ? places?.find((candidate) => candidate.id === features[0]?.properties?.id)
        : undefined;
      if (place && activeListId) {
        setHovered((current) =>
          current?.listId === activeListId && current.id === place.id
            ? current
            : { listId: activeListId, id: place.id },
        );
        return;
      }
      const map = mapRef.current;
      if (map && withinHoverPinBox(map, event, hoverPin ? [hoverPin.lng, hoverPin.lat] : null)) {
        return;
      }
      setHovered(null);
    },
  });

  return null;
}
