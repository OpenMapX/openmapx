import type { PressEventWithFeatures } from "@maplibre/maplibre-react-native";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { CategoryPlace, TransitStop, TransportMode } from "@openmapx/core";
import {
  resolveStopAsPlace,
  useCategorySearchStore,
  useFilteredCategoryResults,
  usePlaceStore,
  useTransitStops,
} from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import type { NativeSyntheticEvent } from "react-native";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "category-results-source";
const CIRCLE_LAYER_ID = "category-results-circles";
const LABEL_LAYER_ID = "category-results-labels";

const TRANSIT_SOURCE_ID = "transit-stops-source";
const TRANSIT_CIRCLE_LAYER_ID = "transit-stops-circles";
const TRANSIT_LABEL_LAYER_ID = "transit-stops-labels";

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function buildCategoryGeoJson(results: CategoryPlace[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: results.map((place) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: place.coordinates,
      },
      properties: {
        id: place.id,
        name: place.name,
        address: place.address ?? "",
        category: place.category ?? "",
      },
    })),
  };
}

function buildTransitGeoJson(stops: TransitStop[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: stops.map((stop) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [stop.lng, stop.lat],
      },
      properties: {
        id: stop.id,
        name: stop.name,
        mode: stop.modes[0] ?? "bus",
        lat: stop.lat,
        lng: stop.lng,
        modes: JSON.stringify(stop.modes),
        provider: stop.provider ?? "",
        platformCode: stop.platformCode ?? "",
        parentStationId: stop.parentStationId ?? "",
      },
    })),
  };
}

/** Color map for transit modes */
const _TRANSIT_MODE_COLORS: Partial<Record<TransportMode, string>> = {
  rail: "#1565c0",
  tram: "#00695c",
  bus: "#e65100",
};

export function CategoryResultMarkers() {
  const { flyTo } = useMap();
  const router = useRouter();
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const { activeCategory, searchBbox } = useCategorySearchStore();
  const { filtered: results, isTransitCategory } = useFilteredCategoryResults();
  const { data: transitStops } = useTransitStops(isTransitCategory ? searchBbox : null);

  // Resolve category marker color
  const markerColor = "#E53935";

  const handleCategoryPress = useCallback(
    (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
      event.stopPropagation();
      const feature = event.nativeEvent.features?.[0];
      if (!feature?.properties) return;
      const props = feature.properties as {
        id: string;
        name: string;
        address: string;
        category: string;
      };
      const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
      flyTo(coords, 17);
      setSelectedPlace({
        id: props.id,
        name: props.name,
        address: props.address || props.name,
        coordinates: coords,
        category: props.category || undefined,
      });
      router.push(`/place/${encodeURIComponent(props.id)}`);
    },
    [flyTo, setSelectedPlace, router],
  );

  const handleTransitPress = useCallback(
    (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
      event.stopPropagation();
      const feature = event.nativeEvent.features?.[0];
      if (!feature?.properties) return;
      const props = feature.properties as {
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
        provider: props.provider || "",
        platformCode: props.platformCode || undefined,
        parentStationId: props.parentStationId || undefined,
      };
      flyTo([stop.lng, stop.lat], 16);
      void resolveStopAsPlace(stop).then((place) => {
        setSelectedPlace(place);
        router.push(`/place/${encodeURIComponent(place.id)}`);
      });
    },
    [flyTo, setSelectedPlace, router],
  );

  const categoryGeojson = useMemo(() => {
    if (!activeCategory || isTransitCategory || !results?.length) return EMPTY_GEOJSON;
    return buildCategoryGeoJson(results);
  }, [activeCategory, isTransitCategory, results]);

  const transitGeojson = useMemo(() => {
    if (!isTransitCategory || !transitStops?.length) return EMPTY_GEOJSON;
    return buildTransitGeoJson(transitStops);
  }, [isTransitCategory, transitStops]);

  if (!activeCategory) return null;

  return (
    <>
      {/* Category results (non-transit) */}
      {!isTransitCategory && categoryGeojson.features.length > 0 && (
        <GeoJSONSource
          id={SOURCE_ID}
          data={categoryGeojson}
          onPress={handleCategoryPress}
          hitbox={{ top: 22, right: 22, bottom: 22, left: 22 }}
        >
          <Layer
            type="circle"
            id={CIRCLE_LAYER_ID}
            paint={{
              "circle-radius": 7,
              "circle-color": markerColor,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2,
            }}
          />
          <Layer
            type="symbol"
            id={LABEL_LAYER_ID}
            layout={{
              "text-field": ["get", "name"],
              "text-size": 11,
              "text-offset": [0, 1.8],
              "text-anchor": "top",
              "text-max-width": 8,
              "text-optional": true,
            }}
            paint={{
              "text-color": "#333333",
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.5,
            }}
          />
        </GeoJSONSource>
      )}

      {/* Transit stops */}
      {isTransitCategory && transitGeojson.features.length > 0 && (
        <GeoJSONSource
          id={TRANSIT_SOURCE_ID}
          data={transitGeojson}
          onPress={handleTransitPress}
          hitbox={{ top: 22, right: 22, bottom: 22, left: 22 }}
        >
          <Layer
            type="circle"
            id={TRANSIT_CIRCLE_LAYER_ID}
            paint={{
              "circle-radius": 7,
              "circle-color": [
                "match",
                ["get", "mode"],
                "rail",
                "#1565c0",
                "tram",
                "#00695c",
                "bus",
                "#e65100",
                "#00695c",
              ],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2,
            }}
          />
          <Layer
            type="symbol"
            id={TRANSIT_LABEL_LAYER_ID}
            layout={{
              "text-field": ["get", "name"],
              "text-size": 11,
              "text-offset": [0, 1.8],
              "text-anchor": "top",
              "text-max-width": 8,
              "text-optional": true,
            }}
            paint={{
              "text-color": "#333333",
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.5,
            }}
          />
        </GeoJSONSource>
      )}
    </>
  );
}
