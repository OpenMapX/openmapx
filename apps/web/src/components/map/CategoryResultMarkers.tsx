"use client";

import type { CategoryPlace } from "@openmapx/core";
import {
  CATEGORY_DEFINITIONS,
  createPlace,
  idsFromPrimaryOrCoords,
  PANEL,
  resolveStopAsPlace,
  useCategorySearchStore,
  useExploreResults,
  usePlaceStore,
  useSidebarStore,
  useTransitStops,
} from "@openmapx/core";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import type { GeoJSONSource, Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { usePinMarker } from "@/hooks/usePinMarker";
import { useMap } from "@/lib/MapContext";
import { createMarkerSvg } from "@/lib/markerSvg";

const SOURCE_ID = "category-results-source";
const LAYER_ID = "category-results-layer";
const LABEL_LAYER_ID = "category-results-labels";

/**
 * Creates a 64×64 SVG (2× for retina): red circle with a white MUI icon path.
 * The icon uses a 24×24 viewBox scaled and centered inside the circle.
 */

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

const TRANSIT_SOURCE_ID = "transit-stops-source";
const TRANSIT_LAYER_ID = "transit-stops-layer";
const TRANSIT_LABEL_LAYER_ID = "transit-stops-labels";

const TRANSIT_BUS_ICON_PATH =
  "M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z";

const TEXT_MARKER_ICON_PATH =
  "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z";

const TRANSIT_MODE_ICON_PATHS: Partial<Record<TransportMode, string>> = {
  rail: "M4 15.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V5c0-3.5-3.58-4-8-4s-8 .5-8 4v10.5zm8 1.5c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm6-7H6V5h12v5z",
  bus: TRANSIT_BUS_ICON_PATH,
  tram: "M19 16.94V8.5c0-2.79-2.61-3.4-5.5-3.5l.9-1.5H19V2H5v1.5h4.4L8.5 5C5.6 5.1 3 5.73 3 8.5v8.44c0 1.45 1.19 2.56 2.59 2.56L4 21v.5h2l2-2h8l2 2h2V21l-1.59-1.5c1.4 0 2.59-1.11 2.59-2.56zM12.5 5h-1l.9-1.5h.2L12.5 5zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V8.5c0-.67.69-1 3-1h6c2.31 0 3 .33 3 1V11z",
};

function createTransitMarkerSvg(mode: TransportMode): string {
  const iconPath = TRANSIT_MODE_ICON_PATHS[mode] ?? TRANSIT_BUS_ICON_PATH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
    <circle cx="24" cy="24" r="21" fill="#00695C" stroke="white" stroke-width="3"/>
    <path d="${iconPath}" fill="white" transform="translate(8, 8) scale(1.333)"/>
  </svg>`;
}

function loadTransitMarkerImage(map: MaplibreMap, mode: TransportMode): Promise<string> {
  const imageId = `transit-marker-${mode}`;
  return new Promise((resolve) => {
    if (map.hasImage(imageId)) {
      resolve(imageId);
      return;
    }
    const img = new Image(48, 48);
    img.onload = () => {
      if (!map.hasImage(imageId)) map.addImage(imageId, img, { pixelRatio: 2 });
      resolve(imageId);
    };
    img.onerror = () => resolve(imageId);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createTransitMarkerSvg(mode))}`;
  });
}

function buildTransitGeoJson(stops: TransitStop[]) {
  return {
    type: "FeatureCollection" as const,
    features: stops.map((stop) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [stop.lng, stop.lat] as [number, number] },
      properties: {
        id: stop.id,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        modes: JSON.stringify(stop.modes),
        provider: stop.provider,
        platformCode: stop.platformCode ?? "",
        parentStationId: stop.parentStationId ?? "",
        imageId: `transit-marker-${stop.modes[0] ?? "bus"}`,
      },
    })),
  };
}

export function CategoryResultMarkers() {
  const { mapRef, mapReady, styleVersion, flyTo } = useMap();
  const {
    activeCategory,
    mode,
    textQuery,
    searchBbox,
    hoveredCategoryPlaceId,
    setHoveredCategoryPlaceId,
  } = useCategorySearchStore();
  const { setSelectedPlace } = usePlaceStore();

  const { filtered: results, isTransitCategory } = useExploreResults();
  const { data: transitStops } = useTransitStops(isTransitCategory ? searchBbox : null);

  // Resolve hovered place for the pin marker
  const hoveredPlace = results?.find((p) => p.id === hoveredCategoryPlaceId) ?? null;
  usePinMarker(hoveredPlace?.coordinates ?? null, hoveredPlace?.name ?? "");

  // Sync GeoJSON source + layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const removeCategoryLayers = () => {
      if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };

    const removeTransitLayers = () => {
      if (map.getLayer(TRANSIT_LABEL_LAYER_ID)) map.removeLayer(TRANSIT_LABEL_LAYER_ID);
      if (map.getLayer(TRANSIT_LAYER_ID)) map.removeLayer(TRANSIT_LAYER_ID);
      if (map.getSource(TRANSIT_SOURCE_ID)) map.removeSource(TRANSIT_SOURCE_ID);
    };

    const sync = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", sync);
        return;
      }

      const hasContext = mode === "text" ? Boolean(textQuery) : Boolean(activeCategory);
      if (!hasContext) {
        removeCategoryLayers();
        removeTransitLayers();
        return;
      }

      // Transit branch: use transit stops source/layers
      if (isTransitCategory) {
        removeCategoryLayers();

        if (!transitStops?.length) {
          removeTransitLayers();
          return;
        }

        const geojson = buildTransitGeoJson(transitStops);

        if (map.getSource(TRANSIT_SOURCE_ID)) {
          (map.getSource(TRANSIT_SOURCE_ID) as GeoJSONSource).setData(geojson);
        } else {
          map.addSource(TRANSIT_SOURCE_ID, { type: "geojson", data: geojson });
        }

        // Load marker images for all unique modes, then add layers
        const uniqueModes = Array.from(new Set(transitStops.flatMap((s) => s.modes)));
        void Promise.all(uniqueModes.map((m) => loadTransitMarkerImage(map, m))).then(() => {
          if (!map.getSource(TRANSIT_SOURCE_ID)) return;
          if (!map.getLayer(TRANSIT_LAYER_ID)) {
            map.addLayer({
              id: TRANSIT_LAYER_ID,
              type: "symbol",
              source: TRANSIT_SOURCE_ID,
              layout: {
                "icon-image": ["get", "imageId"],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
            });
          }
          if (!map.getLayer(TRANSIT_LABEL_LAYER_ID)) {
            map.addLayer({
              id: TRANSIT_LABEL_LAYER_ID,
              type: "symbol",
              source: TRANSIT_SOURCE_ID,
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
        return;
      }

      // Non-transit branch: regular category markers
      removeTransitLayers();

      if (!results?.length) {
        removeCategoryLayers();
        return;
      }

      const def = CATEGORY_DEFINITIONS.find((d) => d.id === activeCategory);
      const iconPath = mode === "text" ? TEXT_MARKER_ICON_PATH : (def?.iconPath ?? "");
      const imageId =
        mode === "text" ? "category-marker-text" : `category-marker-${activeCategory}`;
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
  }, [
    results,
    activeCategory,
    mode,
    textQuery,
    isTransitCategory,
    transitStops,
    mapReady,
    styleVersion,
    mapRef,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const map = mapRef.current;
      if (!map) return;
      try {
        if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        if (map.getLayer(TRANSIT_LABEL_LAYER_ID)) map.removeLayer(TRANSIT_LABEL_LAYER_ID);
        if (map.getLayer(TRANSIT_LAYER_ID)) map.removeLayer(TRANSIT_LAYER_ID);
        if (map.getSource(TRANSIT_SOURCE_ID)) map.removeSource(TRANSIT_SOURCE_ID);
      } catch {
        // Map may already be destroyed
      }
    };
  }, [mapRef]);

  // Click + hover handlers on map markers
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
        phone: string;
        website: string;
        openingHours: string;
      };
      const coords = (features[0].geometry as unknown as { coordinates: [number, number] })
        .coordinates;
      flyTo(coords, 17);
      setSelectedPlace(
        createPlace({
          ...idsFromPrimaryOrCoords(props.id, coords),
          name: props.name,
          address: props.address || props.name,
          coordinates: coords,
          category: props.category || undefined,
          phone: props.phone || undefined,
          website: props.website || undefined,
          openingHours: props.openingHours || undefined,
        }),
      );
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    };

    clickHandlerRef.current = onClick;
    map.on("click", LAYER_ID, onClick);

    const onMouseMove = (e: MapMouseEvent) => {
      const layers = [LAYER_ID, TRANSIT_LAYER_ID].filter((id) => !!map.getLayer(id));
      if (layers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
        const catFeatures = features.filter((f) => f.layer.id === LAYER_ID && f.properties?.id);
        if (catFeatures.length) {
          setHoveredCategoryPlaceId((catFeatures[0].properties as { id: string }).id);
        }
      } else {
        map.getCanvasContainer().style.cursor = "";
        setHoveredCategoryPlaceId(null);
      }
    };

    // Transit layer click handler
    const onTransitClick = (e: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [TRANSIT_LAYER_ID] });
      if (!features.length) return;
      const props = features[0].properties as {
        id: string;
        name: string;
        lat: number;
        lng: number;
        modes: string;
        provider: string;
        platformCode: string;
        parentStationId: string;
      };
      const stop: TransitStop = {
        id: props.id,
        name: props.name,
        lat: Number(props.lat),
        lng: Number(props.lng),
        modes: JSON.parse(props.modes) as TransportMode[],
        provider: props.provider,
        platformCode: props.platformCode || undefined,
        parentStationId: props.parentStationId || undefined,
      };
      flyTo([stop.lng, stop.lat], 16);
      void resolveStopAsPlace(stop).then((place) => {
        setSelectedPlace(place);
        useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
      });
    };

    map.on("mousemove", onMouseMove);
    map.on("click", TRANSIT_LAYER_ID, onTransitClick);

    return () => {
      map.off("click", LAYER_ID, onClick);
      map.off("click", TRANSIT_LAYER_ID, onTransitClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
    };
  }, [mapReady, styleVersion, mapRef, setSelectedPlace, flyTo, setHoveredCategoryPlaceId]);

  return null;
}
