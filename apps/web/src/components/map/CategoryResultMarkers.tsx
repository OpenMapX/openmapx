"use client";

import type { CategoryPlace, OpeningHoursFilter } from "@openmapx/core";
import {
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

import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { usePinMarker } from "@/hooks/usePinMarker";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "category-results-source";
const LAYER_ID = "category-results-layer";
const LABEL_LAYER_ID = "category-results-labels";

function buildGeoJson(results: CategoryPlace[]) {
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

      const geojson = buildGeoJson(results);

      if (map.getSource(SOURCE_ID)) {
        (map.getSource(SOURCE_ID) as GeoJSONSource).setData(geojson);
      } else {
        map.addSource(SOURCE_ID, { type: "geojson", data: geojson });
      }

      if (!map.getLayer(LAYER_ID)) {
        map.addLayer({
          id: LAYER_ID,
          type: "circle",
          source: SOURCE_ID,
          paint: {
            "circle-radius": 8,
            "circle-color": "#E54033",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#FFFFFF",
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
            "text-offset": [0, 1.6],
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
