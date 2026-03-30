import type { ClientEnv } from "./env";

const SELF_HOSTED_STYLES: Record<string, string> = {
  "bright-v2": "osm-bright",
  "streets-v2": "osm-bright",
  "streets-v2-dark": "dark-matter",
  satellite: "osm-bright",
  "topo-v2": "osm-bright",
};

export function maptilerStyleUrl(style = "bright-v2", env: ClientEnv): string {
  if (env.mapStyleUrl) {
    const base = env.mapStyleUrl.replace(/\/$/, "");
    const mappedStyle = SELF_HOSTED_STYLES[style] ?? "osm-bright";
    return `${base}/styles/${mappedStyle}/style.json`;
  }
  return `https://api.maptiler.com/maps/${style}/style.json?key=${env.maptilerKey}`;
}

export async function loadOpenMapXStyle(env: ClientEnv): Promise<Record<string, unknown>> {
  const res = await fetch("/styles/openmapx-streets.json");
  const style = await res.json();

  const tilesUrl =
    env.tilesUrl ||
    `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${env.maptilerKey}`;
  style.sources.openmaptiles.url = tilesUrl;

  style.sprite = `${window.location.origin}/styles/sprite`;

  const glyphBase = env.mapStyleUrl
    ? `${env.mapStyleUrl.replace(/\/$/, "")}/fonts`
    : `https://api.maptiler.com/fonts`;
  const glyphSuffix = env.mapStyleUrl ? "" : `?key=${env.maptilerKey}`;
  style.glyphs = `${glyphBase}/{fontstack}/{range}.pbf${glyphSuffix}`;

  return style;
}
