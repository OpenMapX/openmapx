import type { PressEventWithFeatures } from "@maplibre/maplibre-react-native";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { usePlaceStore, useSavedListPlaces, useSavedPlacesStore } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import type { NativeSyntheticEvent } from "react-native";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "saved-places-source";
const LAYER_ID = "saved-places-layer";

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Renders saved/bookmarked places as red markers on the map.
 * Shows places from the currently selected list when viewing a list detail.
 */
export function SavedPlacesLayer() {
  const { flyTo } = useMap();
  const router = useRouter();
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const { data: places } = useSavedListPlaces(selectedListId);

  const handlePress = useCallback(
    (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
      event.stopPropagation();
      const feature = event.nativeEvent.features?.[0];
      if (!feature?.properties) return;
      const props = feature.properties as { id: string; name: string; address: string };
      const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
      flyTo(coords, 17);
      setSelectedPlace({
        id: props.id,
        name: props.name,
        address: props.address || props.name,
        coordinates: coords,
      });
      router.push(`/place/${encodeURIComponent(props.id)}`);
    },
    [flyTo, setSelectedPlace, router],
  );

  const geojson = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!selectedListId || !places || places.length === 0) return EMPTY_GEOJSON;

    return {
      type: "FeatureCollection",
      features: places.map((place) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [place.lng, place.lat],
        },
        properties: {
          id: place.id,
          name: place.name,
          address: place.address ?? "",
        },
      })),
    };
  }, [selectedListId, places]);

  if (geojson.features.length === 0) return null;

  return (
    <GeoJSONSource
      id={SOURCE_ID}
      data={geojson}
      onPress={handlePress}
      hitbox={{ top: 22, right: 22, bottom: 22, left: 22 }}
    >
      <Layer
        type="circle"
        id={LAYER_ID}
        paint={{
          "circle-radius": 8,
          "circle-color": "#E53935",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        }}
      />
    </GeoJSONSource>
  );
}
