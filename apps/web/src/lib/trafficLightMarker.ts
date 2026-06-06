/**
 * Traffic-light icon for the navigation traffic-signals layer.
 * Registered once via map.addImage(); rendered by NavTrafficSignalsLayer.
 */
import type { Map as MaplibreMap } from "maplibre-gl";

export const TRAFFIC_LIGHT_IMAGE_ID = "nav-traffic-light";

// Drawn at 2x (44x92) and registered with pixelRatio 2 so it stays crisp on
// retina while occupying ~22x46 logical px on the map.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="92">
  <rect x="6" y="2" width="32" height="88" rx="8" fill="#202124" stroke="#ffffff" stroke-width="3"/>
  <circle cx="22" cy="24" r="8.8" fill="#EA4335"/>
  <circle cx="22" cy="46" r="8.8" fill="#FBBC04"/>
  <circle cx="22" cy="68" r="8.8" fill="#34A853"/>
</svg>`;

/** Register the traffic-light image on the map (no-op if already present). */
export function loadTrafficLightImage(map: MaplibreMap): void {
  if (map.hasImage(TRAFFIC_LIGHT_IMAGE_ID)) return;
  const img = new Image(44, 92);
  img.onload = () => {
    if (!map.hasImage(TRAFFIC_LIGHT_IMAGE_ID)) {
      map.addImage(TRAFFIC_LIGHT_IMAGE_ID, img, { pixelRatio: 2 });
    }
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;
}
