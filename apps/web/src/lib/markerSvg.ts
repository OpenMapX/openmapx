/**
 * Shared circular marker SVG generator for MapLibre GL JS.
 * Used by DataSourceLayer, CategoryResultMarkers, and transitMarkers.
 */
export function createMarkerSvg(iconPath: string, fill = "#E54033", size = 64): string {
  const r = size / 2;
  const iconScale = size / 48;
  const iconOffset = (size - 24 * iconScale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="${r}" cy="${r}" r="${r - 3}" fill="${fill}" stroke="white" stroke-width="4"/>
    <path d="${iconPath}" fill="white" transform="translate(${iconOffset}, ${iconOffset}) scale(${iconScale})"/>
  </svg>`;
}
