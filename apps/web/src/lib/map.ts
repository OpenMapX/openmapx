import type { ClientEnv } from "./env";

const SELF_HOSTED_STYLES: Record<string, string> = {
  "bright-v2": "osm-bright",
  "streets-v2": "osm-bright",
  "streets-v2-dark": "dark-matter",
  satellite: "osm-bright",
  "topo-v2": "osm-bright",
};

function apiRoute(env: ClientEnv, path: string): string {
  const base = env.apiUrl.replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

export function maptilerStyleUrl(style = "bright-v2", env: ClientEnv): string {
  if (env.mapStyleUrl) {
    const base = env.mapStyleUrl.replace(/\/$/, "");
    const mappedStyle = SELF_HOSTED_STYLES[style] ?? "osm-bright";
    return `${base}/styles/${mappedStyle}/style.json`;
  }
  return apiRoute(env, `/api/maptiler/maps/${encodeURIComponent(style)}/style.json`);
}

export async function loadOpenMapXStyle(env: ClientEnv): Promise<Record<string, unknown>> {
  const res = await fetch("/styles/openmapx-streets.json");
  const style = await res.json();

  const tilesUrl = env.tilesUrl || apiRoute(env, "/api/maptiler/tiles/v3-openmaptiles/tiles.json");
  style.sources.openmaptiles.url = tilesUrl;

  style.sprite = `${window.location.origin}/styles/sprite`;

  const glyphBase = env.mapStyleUrl
    ? `${env.mapStyleUrl.replace(/\/$/, "")}/fonts`
    : apiRoute(env, "/api/maptiler/fonts");
  style.glyphs = `${glyphBase}/{fontstack}/{range}.pbf`;

  return style;
}
