import { Layer, VectorSource } from "@maplibre/maplibre-react-native";
import { useStreetViewStore } from "@openmapx/core";
import { useCallback } from "react";
import type { NativeSyntheticEvent } from "react-native";

const MLY_SOURCE_ID = "mly1_public";
const MLY_SEQUENCE_LAYER = "mapillary-sequence-layer";
const MLY_PHOTO_LAYER = "mapillary-photo-layer";
const MLY_PANO_LAYER = "mapillary-pano-layer";

interface PressEventPayload {
  features: GeoJSON.Feature[];
}

export function StreetViewLayer() {
  const layerVisible = useStreetViewStore((s) => s.layerVisible);
  const setActiveImageId = useStreetViewStore((s) => s.setActiveImageId);

  const handlePress = useCallback(
    (event: NativeSyntheticEvent<PressEventPayload>) => {
      const feature = event.nativeEvent.features?.[0];
      const id = feature?.properties?.id;
      if (id != null) {
        setActiveImageId(String(id));
      }
    },
    [setActiveImageId],
  );

  if (!layerVisible) return null;

  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "";
  const tileUrl = `${apiUrl}/api/mapillary/tiles/{z}/{x}/{y}`;

  return (
    <VectorSource
      id={MLY_SOURCE_ID}
      tiles={[tileUrl]}
      minzoom={6}
      maxzoom={14}
      onPress={handlePress}
      hitbox={{ top: 22, right: 22, bottom: 22, left: 22 }}
    >
      <Layer
        type="line"
        id={MLY_SEQUENCE_LAYER}
        source-layer="sequence"
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": "#03a9f4",
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 14, 4],
          "line-opacity": 0.85,
        }}
      />
      <Layer
        type="circle"
        id={MLY_PHOTO_LAYER}
        source-layer="image"
        filter={["==", ["get", "is_pano"], false]}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 6],
          "circle-color": "#03a9f4",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1,
        }}
      />
      <Layer
        type="circle"
        id={MLY_PANO_LAYER}
        source-layer="image"
        filter={["==", ["get", "is_pano"], true]}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 10],
          "circle-color": "rgba(3,169,244,0.15)",
          "circle-stroke-color": "#03a9f4",
          "circle-stroke-width": 2,
        }}
      />
    </VectorSource>
  );
}
