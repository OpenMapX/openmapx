import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { usePlaceStore } from "@openmapx/core";
import { useMemo } from "react";

const SOURCE_ID = "vehicle-live-source";
const LAYER_ID = "vehicle-live-layer";
const PRIMARY_BLUE_HEX = "#4285F4";

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Live vehicle positions for transit routes.
 * Shows dots for vehicles on the currently active route.
 * Full integration depends on useRouteLive/useTransitRoute hooks
 * which require the transit detail panel (Phase 7.3).
 */
export function VehicleLiveLayer() {
  const activeRouteId = usePlaceStore((s) => s.activeRouteId);

  // Stub: full integration in Phase 7.3 when transit route details
  // and vehicle live data hooks are wired.
  const geojson = useMemo(() => {
    if (!activeRouteId) return EMPTY_GEOJSON;
    return EMPTY_GEOJSON;
  }, [activeRouteId]);

  if (geojson.features.length === 0) return null;

  return (
    <GeoJSONSource id={SOURCE_ID} data={geojson}>
      <Layer
        type="circle"
        id={LAYER_ID}
        paint={{
          "circle-radius": 10,
          "circle-color": PRIMARY_BLUE_HEX,
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.95,
        }}
      />
    </GeoJSONSource>
  );
}
