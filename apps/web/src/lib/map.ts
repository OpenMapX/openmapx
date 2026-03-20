/** MapTiler API key from environment. */
export const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";

/** Default MapTiler style URL for all map instances (main map, minimap, etc.). */
export function maptilerStyleUrl(style = "bright-v2"): string {
  return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_KEY}`;
}
