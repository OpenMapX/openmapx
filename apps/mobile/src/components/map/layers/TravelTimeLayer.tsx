import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { IsochroneTravelMode } from "@openmapx/core";
import { useIsochrone, useTravelTimeStore } from "@openmapx/core";
import { useMemo } from "react";

const MODE_COLORS: Record<IsochroneTravelMode, string> = {
  driving: "#1A73E8",
  walking: "#34A853",
  cycling: "#F9AB00",
};

function computeOpacity(index: number, total: number): number {
  if (total <= 1) return 0.2;
  const maxOpacity = 0.25;
  const minOpacity = 0.08;
  const t = (total - 1 - index) / (total - 1);
  return minOpacity + t * (maxOpacity - minOpacity);
}

export function TravelTimeLayer() {
  const isActive = useTravelTimeStore((s) => s.isActive);
  const origin = useTravelTimeStore((s) => s.origin);
  const mode = useTravelTimeStore((s) => s.mode);
  const selectedMinutes = useTravelTimeStore((s) => s.selectedMinutes);

  const { data: isochroneData } = useIsochrone({
    origin,
    mode,
    contourMinutes: selectedMinutes,
    enabled: isActive,
  });

  const fillGeoJSON = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!isochroneData || isochroneData.contours.length === 0) {
      return { type: "FeatureCollection", features: [] };
    }

    const color = MODE_COLORS[isochroneData.mode];
    const total = isochroneData.contours.length;

    const features: GeoJSON.Feature[] = [...isochroneData.contours]
      .sort((a, b) => b.time - a.time)
      .map((contour, i) => ({
        type: "Feature",
        geometry: contour.geometry,
        properties: {
          color,
          opacity: computeOpacity(i, total),
          time: contour.time,
        },
      }));

    return { type: "FeatureCollection", features };
  }, [isochroneData]);

  const originGeoJSON = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!origin) {
      return { type: "FeatureCollection", features: [] };
    }

    const color = MODE_COLORS[mode];
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: origin },
          properties: { color },
        },
      ],
    };
  }, [origin, mode]);

  if (!isActive) return null;

  return (
    <>
      <GeoJSONSource id="travel-time-source" data={fillGeoJSON}>
        {/* Isochrone fill */}
        <Layer
          type="fill"
          id="travel-time-fill"
          source="travel-time-source"
          paint={{
            "fill-color": ["get", "color"],
            "fill-opacity": ["get", "opacity"],
          }}
        />
        {/* Isochrone outline */}
        <Layer
          type="line"
          id="travel-time-outline"
          source="travel-time-source"
          paint={{
            "line-color": ["get", "color"],
            "line-width": 2,
            "line-opacity": 0.6,
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="travel-time-origin-source" data={originGeoJSON}>
        {/* Origin pulse ring */}
        <Layer
          type="circle"
          id="travel-time-origin-pulse"
          source="travel-time-origin-source"
          paint={{
            "circle-radius": 14,
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": ["get", "color"],
            "circle-stroke-width": 2,
            "circle-stroke-opacity": 0.3,
          }}
        />
        {/* Origin dot */}
        <Layer
          type="circle"
          id="travel-time-origin"
          source="travel-time-origin-source"
          paint={{
            "circle-radius": 7,
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#FFFFFF",
            "circle-stroke-width": 2,
          }}
        />
      </GeoJSONSource>
    </>
  );
}
