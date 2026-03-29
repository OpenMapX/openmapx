import { Layer, VectorSource } from "@maplibre/maplibre-react-native";
import { useCyclingStore } from "@openmapx/core";

const CYCLING_MIN_ZOOM = 10;

const CYCLING_COLORS = {
  track: "#0D7C3D",
  lane: "#2E8B57",
  designated: "#4A90D9",
  permitted: "#7CB342",
  parking: "#1565C0",
  shop: "#6A1B9A",
  repair: "#E65100",
  rental: "#00838F",
} as const;

const TRACKS_LAYER = "openmapx-cycling-tracks";
const LANES_LAYER = "openmapx-cycling-lanes";
const DESIGNATED_LAYER = "openmapx-cycling-designated";
const PERMITTED_LAYER = "openmapx-cycling-permitted";
const PARKING_LAYER = "openmapx-cycling-parking";
const SHOPS_LAYER = "openmapx-cycling-shops";

/**
 * Cycling infrastructure overlay using MapTiler vector tiles.
 * Adds dedicated cycling layers from the OpenMapTiles transportation
 * and poi source layers.
 */
export function CyclingLayer() {
  const layerVisible = useCyclingStore((s) => s.layerVisible);

  if (!layerVisible) return null;

  const maptilerKey = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";
  const tileUrl = `https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=${maptilerKey}`;

  return (
    <VectorSource id="openmapx-cycling-source" tiles={[tileUrl]} maxzoom={14}>
      {/* Dedicated cycleways */}
      <Layer
        type="line"
        id={TRACKS_LAYER}
        source-layer="transportation"
        minzoom={CYCLING_MIN_ZOOM}
        filter={["all", ["==", ["get", "class"], "path"], ["==", ["get", "subclass"], "cycleway"]]}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": CYCLING_COLORS.track,
          "line-opacity": 0.85,
          "line-width": ["interpolate", ["linear"], ["zoom"], CYCLING_MIN_ZOOM, 1.5, 14, 3, 18, 5],
        }}
      />
      {/* Bike lanes (designated) */}
      <Layer
        type="line"
        id={LANES_LAYER}
        source-layer="transportation"
        minzoom={12}
        filter={[
          "all",
          [
            "in",
            ["get", "class"],
            ["literal", ["primary", "secondary", "tertiary", "minor", "service"]],
          ],
          ["==", ["get", "bicycle"], "designated"],
        ]}
        layout={{ "line-cap": "butt", "line-join": "round" }}
        paint={{
          "line-color": CYCLING_COLORS.lane,
          "line-opacity": 0.8,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.5, 14, 3, 18, 4],
          "line-dasharray": [2, 1],
        }}
      />
      {/* Bicycle-designated roads */}
      <Layer
        type="line"
        id={DESIGNATED_LAYER}
        source-layer="transportation"
        minzoom={14}
        filter={[
          "all",
          [
            "in",
            ["get", "class"],
            ["literal", ["primary", "secondary", "tertiary", "minor", "service", "track"]],
          ],
          ["==", ["get", "bicycle"], "yes"],
        ]}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": CYCLING_COLORS.designated,
          "line-opacity": 0.7,
          "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 3],
        }}
      />
      {/* Bicycle-permitted paths */}
      <Layer
        type="line"
        id={PERMITTED_LAYER}
        source-layer="transportation"
        minzoom={14}
        filter={[
          "all",
          ["==", ["get", "class"], "path"],
          ["!=", ["get", "subclass"], "cycleway"],
          ["==", ["get", "bicycle"], "yes"],
        ]}
        layout={{ "line-cap": "butt", "line-join": "round" }}
        paint={{
          "line-color": CYCLING_COLORS.permitted,
          "line-opacity": 0.7,
          "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 3],
          "line-dasharray": [3, 1.5, 1, 1.5],
        }}
      />
      {/* Bike parking POIs */}
      <Layer
        type="circle"
        id={PARKING_LAYER}
        source-layer="poi"
        minzoom={14}
        filter={["==", ["get", "subclass"], "bicycle_parking"]}
        paint={{
          "circle-color": CYCLING_COLORS.parking,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 3, 18, 6],
          "circle-opacity": 0.85,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        }}
      />
      {/* Bike shops + repair + rental */}
      <Layer
        type="circle"
        id={SHOPS_LAYER}
        source-layer="poi"
        minzoom={16}
        filter={[
          "in",
          ["get", "subclass"],
          ["literal", ["bicycle", "bicycle_rental", "bicycle_repair_station"]],
        ]}
        paint={{
          "circle-color": [
            "match",
            ["get", "subclass"],
            "bicycle",
            CYCLING_COLORS.shop,
            "bicycle_repair_station",
            CYCLING_COLORS.repair,
            "bicycle_rental",
            CYCLING_COLORS.rental,
            CYCLING_COLORS.shop,
          ],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 4, 18, 7],
          "circle-opacity": 0.9,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        }}
      />
    </VectorSource>
  );
}
