"use client";

import type { Place } from "@openmapx/core";
import {
  createPlace,
  idsFromPrimaryOrCoords,
  PANEL,
  useNearbyPlaces,
  useNearbyPlacesStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type { GeoJSONSource, Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { usePinMarker } from "@/hooks/usePinMarker";
import { useMap } from "@/lib/MapContext";
import { createMarkerSvg } from "@/lib/markerSvg";

const SOURCE_ID = "nearby-places-source";
const LAYER_ID = "nearby-places-layer";
const LABEL_LAYER_ID = "nearby-places-labels";
const IMAGE_ID = "nearby-place-marker";
const SEARCH_ICON_PATH =
  "M9.5 3a6.5 6.5 0 0 1 5.18 10.43l4.45 4.44-1.42 1.42-4.44-4.45A6.5 6.5 0 1 1 9.5 3m0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9";

function loadMarkerImage(map: MaplibreMap): Promise<void> {
  return new Promise((resolve) => {
    if (map.hasImage(IMAGE_ID)) {
      resolve();
      return;
    }
    const img = new Image(64, 64);
    img.onload = () => {
      if (!map.hasImage(IMAGE_ID)) map.addImage(IMAGE_ID, img, { pixelRatio: 2 });
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createMarkerSvg(SEARCH_ICON_PATH))}`;
  });
}

function buildGeoJson(places: Place[]) {
  return {
    type: "FeatureCollection" as const,
    features: places.map((place) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: place.coordinates },
      properties: {
        id: place.id,
        name: place.name,
        address: place.address,
        category: place.category ?? "",
        rawCategory: place.rawCategory ?? "",
        phone: place.phone ?? "",
        website: place.website ?? "",
        openingHours: place.openingHours ?? "",
      },
    })),
  };
}

function fallbackPlaceFromFeature(
  props: {
    id: string;
    name: string;
    address: string;
    category: string;
    rawCategory: string;
    phone: string;
    website: string;
    openingHours: string;
  },
  coordinates: [number, number],
): Place {
  return createPlace({
    ...idsFromPrimaryOrCoords(props.id, coordinates),
    name: props.name,
    address: props.address || props.name,
    coordinates,
    category: props.category || undefined,
    rawCategory: props.rawCategory || undefined,
    phone: props.phone || undefined,
    website: props.website || undefined,
    openingHours: props.openingHours || undefined,
  });
}

export function NearbyPlaceMarkers() {
  const { mapRef, mapReady, styleVersion, flyTo } = useMap();
  const { sourcePlace, radiusMetres, hoveredNearbyPlaceId, setHoveredNearbyPlaceId } =
    useNearbyPlacesStore();
  const { setSelectedPlace } = usePlaceStore();
  const { data } = useNearbyPlaces(sourcePlace?.coordinates ?? null, radiusMetres, {
    excludeId: sourcePlace?.id,
  });
  const places = useMemo(
    () => (sourcePlace ? (data ?? []).filter((place) => place.id !== sourcePlace.id) : []),
    [data, sourcePlace],
  );
  const hoveredPlace = places.find((place) => place.id === hoveredNearbyPlaceId) ?? null;

  usePinMarker(hoveredPlace?.coordinates ?? null, hoveredPlace?.name ?? "");

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const removeLayers = () => {
      if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };

    const sync = () => {
      if (!map.isStyleLoaded()) return;
      if (!sourcePlace || places.length === 0) {
        removeLayers();
        return;
      }

      const geojson = buildGeoJson(places);
      if (map.getSource(SOURCE_ID)) {
        (map.getSource(SOURCE_ID) as GeoJSONSource).setData(geojson);
      } else {
        map.addSource(SOURCE_ID, { type: "geojson", data: geojson });
      }

      void loadMarkerImage(map).then(() => {
        if (!map.getSource(SOURCE_ID)) return;
        if (!map.getLayer(LAYER_ID)) {
          map.addLayer({
            id: LAYER_ID,
            type: "symbol",
            source: SOURCE_ID,
            layout: {
              "icon-image": IMAGE_ID,
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });
        }
        if (!map.getLayer(LABEL_LAYER_ID)) {
          map.addLayer({
            id: LABEL_LAYER_ID,
            type: "symbol",
            source: SOURCE_ID,
            layout: {
              "text-field": ["get", "name"],
              "text-size": 11,
              "text-offset": [0, 2.0],
              "text-anchor": "top",
              "text-max-width": 8,
            },
            paint: {
              "text-color": "#333333",
              "text-halo-color": "#FFFFFF",
              "text-halo-width": 1.5,
            },
          });
        }
      });
    };

    sync();
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
    };
  }, [places, sourcePlace, mapReady, styleVersion, mapRef]);

  useEffect(() => {
    return () => {
      const map = mapRef.current;
      if (!map) return;
      try {
        if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // Map may already be destroyed
      }
    };
  }, [mapRef]);

  const clickHandlerRef = useRef<((e: MapMouseEvent) => void) | null>(null);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (clickHandlerRef.current) {
      map.off("click", LAYER_ID, clickHandlerRef.current);
    }

    const onClick = (e: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_ID] });
      if (!features.length) return;
      const props = features[0].properties as {
        id: string;
        name: string;
        address: string;
        category: string;
        rawCategory: string;
        phone: string;
        website: string;
        openingHours: string;
      };
      const coords = (features[0].geometry as unknown as { coordinates: [number, number] })
        .coordinates;
      const place =
        places.find((candidate) => candidate.id === props.id) ??
        fallbackPlaceFromFeature(props, coords);

      flyTo(place.coordinates, 17);
      setSelectedPlace(place);
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    };

    clickHandlerRef.current = onClick;
    map.on("click", LAYER_ID, onClick);

    const onMouseMove = (e: MapMouseEvent) => {
      if (!map.getLayer(LAYER_ID)) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_ID] });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
        setHoveredNearbyPlaceId((features[0].properties as { id: string }).id);
      } else {
        map.getCanvasContainer().style.cursor = "";
        setHoveredNearbyPlaceId(null);
      }
    };

    map.on("mousemove", onMouseMove);

    return () => {
      map.off("click", LAYER_ID, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
    };
  }, [places, mapReady, styleVersion, mapRef, setSelectedPlace, flyTo, setHoveredNearbyPlaceId]);

  return null;
}
