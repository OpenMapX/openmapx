"use client";

import type { CategoryPlace, OpeningHoursFilter } from "@openmapx/core";
import {
  CATEGORY_DEFINITIONS,
  isOpenAt,
  parseOpeningHours,
  useCategorySearch,
  useCategorySearchStore,
  usePlaceStore,
} from "@openmapx/core";

function applyHoursFilter(
  results: CategoryPlace[],
  filter: OpeningHoursFilter,
  openAtDay: number | null,
  openAtHour: number | null,
): CategoryPlace[] {
  if (filter === "any") return results;
  if (filter === "open_24h") return results.filter((p) => p.openingHours === "24/7");
  if (filter === "open_now")
    return results.filter((p) => parseOpeningHours(p.openingHours)?.isOpen === true);
  if (filter === "open_at") {
    if (openAtDay === null && openAtHour === null) return results;
    return results.filter((p) => isOpenAt(p.openingHours, openAtDay, openAtHour));
  }
  return results;
}

import type { GeoJSONSource, Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { usePinMarker } from "@/hooks/usePinMarker";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "category-results-source";
const LAYER_ID = "category-results-layer";
const LABEL_LAYER_ID = "category-results-labels";

/**
 * Creates a 64×64 SVG (2× for retina): red circle with a white MUI icon path.
 * The icon uses a 24×24 viewBox scaled and centered inside the circle.
 */
function createMarkerSvg(iconPath: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
    <circle cx="32" cy="32" r="29" fill="#E54033" stroke="white" stroke-width="4"/>
    <path d="${iconPath}" fill="white" transform="translate(13, 13) scale(1.583)"/>
  </svg>`;
}

function loadMarkerImage(map: MaplibreMap, imageId: string, iconPath: string): Promise<void> {
  return new Promise((resolve) => {
    if (map.hasImage(imageId)) {
      resolve();
      return;
    }
    const img = new Image(64, 64);
    img.onload = () => {
      if (!map.hasImage(imageId)) map.addImage(imageId, img, { pixelRatio: 2 });
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createMarkerSvg(iconPath))}`;
  });
}

function buildGeoJson(results: CategoryPlace[], imageId: string) {
  return {
    type: "FeatureCollection" as const,
    features: results.map((place) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: place.coordinates },
      properties: {
        id: place.id,
        name: place.name,
        address: place.address ?? "",
        category: place.category ?? "",
        phone: place.phone ?? "",
        website: place.website ?? "",
        openingHours: place.openingHours ?? "",
        imageId,
      },
    })),
  };
}

export function CategoryResultMarkers() {
  const { mapRef, mapReady, flyTo } = useMap();
  const {
    activeCategory,
    searchBbox,
    hoveredCategoryPlaceId,
    setHoveredCategoryPlaceId,
    openingHoursFilter,
    openAtDay,
    openAtHour,
  } = useCategorySearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { data: rawResults } = useCategorySearch(activeCategory, searchBbox);
  const results = rawResults
    ? applyHoursFilter(rawResults, openingHoursFilter, openAtDay, openAtHour)
    : rawResults;

  // Resolve hovered place for the pin marker
  const hoveredPlace = results?.find((p) => p.id === hoveredCategoryPlaceId) ?? null;
  usePinMarker(hoveredPlace?.coordinates ?? null, hoveredPlace?.name ?? "");

  // Sync GeoJSON source + layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const sync = () => {
      if (!map.isStyleLoaded()) return;

      if (!results?.length || !activeCategory) {
        if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        return;
      }

      const def = CATEGORY_DEFINITIONS.find((d) => d.id === activeCategory);
      const iconPath = def?.iconPath ?? "";
      const imageId = `category-marker-${activeCategory}`;
      const geojson = buildGeoJson(results, imageId);

      if (map.getSource(SOURCE_ID)) {
        (map.getSource(SOURCE_ID) as GeoJSONSource).setData(geojson);
      } else {
        map.addSource(SOURCE_ID, { type: "geojson", data: geojson });
      }

      // Load image then add layers (image may already be cached)
      void loadMarkerImage(map, imageId, iconPath).then(() => {
        if (!map.getSource(SOURCE_ID)) return;
        if (!map.getLayer(LAYER_ID)) {
          map.addLayer({
            id: LAYER_ID,
            type: "symbol",
            source: SOURCE_ID,
            layout: {
              "icon-image": ["get", "imageId"],
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
  }, [results, activeCategory, mapReady, mapRef]);

  // Cleanup on unmount
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

  // Click + hover handlers on map markers
  const clickHandlerRef = useRef<((e: MapMouseEvent) => void) | null>(null);

  useEffect(() => {
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
        phone: string;
        website: string;
        openingHours: string;
      };
      const coords = (features[0].geometry as { coordinates: [number, number] }).coordinates;
      flyTo(coords, 17);
      setSelectedPlace({
        id: props.id,
        name: props.name,
        address: props.address || props.name,
        coordinates: coords,
        category: props.category || undefined,
        phone: props.phone || undefined,
        website: props.website || undefined,
        openingHours: props.openingHours || undefined,
      });
    };

    clickHandlerRef.current = onClick;
    map.on("click", LAYER_ID, onClick);

    const onEnter = (e: MapMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_ID] });
      if (features.length) {
        setHoveredCategoryPlaceId((features[0].properties as { id: string }).id);
      }
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      setHoveredCategoryPlaceId(null);
    };
    map.on("mouseenter", LAYER_ID, onEnter);
    map.on("mouseleave", LAYER_ID, onLeave);

    return () => {
      map.off("click", LAYER_ID, onClick);
      map.off("mouseenter", LAYER_ID, onEnter);
      map.off("mouseleave", LAYER_ID, onLeave);
    };
  }, [mapReady, mapRef, setSelectedPlace, flyTo, setHoveredCategoryPlaceId]);

  return null;
}
