/**
 * Transit vehicle marker icons for MapLibre layers.
 *
 * Uses the same SVG-to-Image pattern as DataSourceLayer:
 * 64x64 circle with white icon inside, registered via map.addImage().
 *
 * Icon paths are Material Design Icons (24x24 viewbox), scaled to fit.
 */

import type { TransportMode } from "@openmapx/mobility-core/transit";
import type { Map as MaplibreMap } from "maplibre-gl";
import { createMarkerSvg } from "./markerSvg";

// Material Design icon paths (24x24 viewbox)
const ICON_PATHS: Record<string, string> = {
  // Train (MUI Train)
  rail: "M12 2c-4 0-8 .5-8 4v9.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-3.58-4-8-4zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm3.5-7H6V6h5v4zm2 0V6h5v4h-5zm3.5 7c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z",
  // Bus (MUI DirectionsBus)
  bus: "M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z",
  // Subway (MUI Subway)
  subway:
    "M17.8 2.8C16 2.09 13.86 2 12 2c-1.86 0-4 .09-5.8.8C3.53 3.84 2 6.05 2 8.86V22h20V8.86c0-2.81-1.53-5.02-4.2-6.06zM9.88 20l1.12-2h2l1.12 2H9.88zm-2.38-5c-.83 0-1.5-.67-1.5-1.5S6.67 12 7.5 12s1.5.67 1.5 1.5S8.33 15 7.5 15zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-5h-12V6h12v4z",
  // Tram (MUI Tram)
  tram: "M19 16.94V8.5c0-2.79-2.61-3.4-5.01-3.49l.76-1.51H17V2H7v1.5h4.75l-.76 1.52C8.65 5.11 5 5.73 5 8.5v8.44c0 1.45 1.19 2.56 2.59 2.56L6 21v.5h2.23l2-2H14l2 2h2V21l-1.5-1.5c1.33 0 2.5-1.17 2.5-2.56zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm3.5-4H7V9h4v4zm2 0V9h4v4h-4zm3.5 4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z",
  // Ferry (MUI DirectionsBoat)
  ferry:
    "M20 21c-1.39 0-2.78-.47-4-1.32-2.44 1.71-5.56 1.71-8 0C6.78 20.53 5.39 21 4 21H2v2h2c1.38 0 2.74-.35 4-.99 2.52 1.29 5.48 1.29 8 0 1.26.65 2.62.99 4 .99h2v-2h-2zM3.95 19H4c1.6 0 3.02-.88 4-2 .98 1.12 2.4 2 4 2s3.02-.88 4-2c.98 1.12 2.4 2 4 2h.05l1.89-6.68c.08-.26.06-.54-.06-.78s-.34-.42-.6-.5L20 10.62V6c0-1.1-.9-2-2-2h-3V1H9v3H6c-1.1 0-2 .9-2 2v4.62l-1.29.42c-.26.08-.48.26-.6.5s-.15.52-.06.78L3.95 19zM6 6h12v3.97L12 8 6 9.97V6z",
  // Gondola/Cable car
  gondola:
    "M17 4h2V2H5v2h2l-3 7h1c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2h2c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2h1l-3-7zm-8.75 7L10 6.75 11.75 11H8.25zm7.5 0L13.5 6.25 15.25 5l2.5 6h-3zM2 22h20v-3H2v3z",
};

const MODE_MARKER_COLORS: Record<string, string> = {
  rail: "#1A73E8",
  subway: "#E53935",
  tram: "#F9A825",
  bus: "#0F9D58",
  ferry: "#00ACC1",
  gondola: "#8E24AA",
  funicular: "#8E24AA",
  cable_car: "#8E24AA",
};

const DEFAULT_COLOR = "#8B5CF6";

function imageId(prefix: string, mode: string, variant?: string): string {
  return variant ? `${prefix}-${mode}-${variant}` : `${prefix}-${mode}`;
}

function loadMarkerImage(
  map: MaplibreMap,
  id: string,
  iconPath: string,
  fill: string,
  size = 56,
): void {
  if (map.hasImage(id)) return;
  const img = new Image(size, size);
  img.onload = () => {
    if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createMarkerSvg(iconPath, fill, size))}`;
}

/** Load transit vehicle markers for the TransitVehicle layer (directions). */
export function loadTransitVehicleMarkers(map: MaplibreMap): void {
  for (const [mode, path] of Object.entries(ICON_PATHS)) {
    const color = MODE_MARKER_COLORS[mode] ?? DEFAULT_COLOR;
    loadMarkerImage(map, imageId("tv", mode), path, color);
  }
}

/**
 * Build a MapLibre expression that selects the right image ID
 * based on the "mode" property (for TransitVehicle: rail, bus, tram, etc.)
 */
export function transitVehicleIconExpression(): unknown[] {
  const expr: unknown[] = ["match", ["get", "mode"]];
  for (const mode of Object.keys(ICON_PATHS)) {
    expr.push(mode, imageId("tv", mode));
  }
  expr.push(imageId("tv", "bus")); // fallback to bus
  return expr;
}

/** Resolve marker color for a transport mode. */
export function modeColor(mode: TransportMode): string {
  return MODE_MARKER_COLORS[mode] ?? DEFAULT_COLOR;
}
