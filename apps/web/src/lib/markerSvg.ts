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

/**
 * A 64×64 white pin holding a brand logo.
 *
 * The logo is embedded as a data URI so the SVG rasterizes in one `Image` load
 * with no second network round-trip, and the white disc keeps marks with
 * transparent backgrounds legible over any basemap.
 */
export function createBrandMarkerSvg(logoDataUri: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
    <circle cx="32" cy="32" r="28" fill="white" stroke="#DDDDDD" stroke-width="2"/>
    <image href="${logoDataUri}" x="14" y="14" width="36" height="36" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
}
