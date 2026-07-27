import type maplibregl from "maplibre-gl";

export const BASEMAP_LOD2_TILESET_URL =
  "https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gebaeude/lod2_3857_null.json";
export const BASEMAP_LOD2_RENDERER_URL =
  "https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gebaeude/Maplibre3DTiles.js";

// BKG publishes the renderer at an unversioned URL. Pin the reviewed bytes so
// activating the optional layer cannot silently execute changed third-party
// JavaScript. If BKG updates it, the detailed layer fails closed to the normal
// OpenMapTiles extrusion until this hash is reviewed and updated.
export const BASEMAP_LOD2_RENDERER_INTEGRITY =
  "sha384-q3pnK85xX/QxPjhFutyFScKvWMrmzh3pmdUcx19wM/zWhsLLbguExO88f2LpvmFd";

export const BASEMAP_LOD2_MIN_ZOOM = 16;

const RENDERER_SCRIPT_ID = "openmapx-basemap-de-3d-renderer";
const GERMANY_BOUNDS = {
  west: 5.5,
  south: 47,
  east: 15.5,
  north: 55.2,
} as const;

export interface BasemapLod2Layer extends maplibregl.CustomLayerInterface {
  /** Set to 1 by BKG's renderer after the root tileset is ready. */
  loadStatus?: number;
}

interface BasemapLod2Renderer {
  Mapbox3DTilesLayer: new (options: {
    id: string;
    url: string;
    colorWall: string;
    colorRoof: string;
    colorBridge: string;
  }) => BasemapLod2Layer;
}

declare global {
  interface Window {
    Mapbox3DTiles?: BasemapLod2Renderer;
  }
}

let rendererPromise: Promise<BasemapLod2Renderer> | null = null;

function rendererFromWindow(): BasemapLod2Renderer {
  const renderer = window.Mapbox3DTiles;
  if (!renderer?.Mapbox3DTilesLayer) {
    throw new Error("basemap.de 3D renderer loaded without its layer constructor");
  }
  return renderer;
}

export function loadBasemapLod2Renderer(): Promise<BasemapLod2Renderer> {
  if (window.Mapbox3DTiles?.Mapbox3DTilesLayer) {
    return Promise.resolve(window.Mapbox3DTiles);
  }
  if (rendererPromise) return rendererPromise;

  rendererPromise = new Promise<BasemapLod2Renderer>((resolve, reject) => {
    const existing = document.getElementById(RENDERER_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");

    const handleLoad = () => {
      try {
        resolve(rendererFromWindow());
      } catch (error) {
        rendererPromise = null;
        script.remove();
        reject(error);
      }
    };
    const handleError = () => {
      rendererPromise = null;
      script.remove();
      reject(new Error("Unable to load the integrity-pinned basemap.de 3D renderer"));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existing) {
      script.id = RENDERER_SCRIPT_ID;
      script.src = BASEMAP_LOD2_RENDERER_URL;
      script.integrity = BASEMAP_LOD2_RENDERER_INTEGRITY;
      script.crossOrigin = "anonymous";
      script.async = true;
      document.head.append(script);
    }
  });

  return rendererPromise;
}

export async function createBasemapLod2Layer(id: string): Promise<BasemapLod2Layer> {
  const renderer = await loadBasemapLod2Renderer();
  return new renderer.Mapbox3DTilesLayer({
    id,
    url: BASEMAP_LOD2_TILESET_URL,
    colorWall: "#c8c4c0",
    colorRoof: "#b86f63",
    colorBridge: "#8f9094",
  });
}

/**
 * BKG's MapLibre tileset is Web Mercator, Germany-only, and expensive enough
 * that its own example starts it at z16. Everywhere else the existing vector
 * extrusion remains the correct low-cost fallback.
 */
export function supportsBasemapLod2View(map: maplibregl.Map): boolean {
  if (map.getZoom() < BASEMAP_LOD2_MIN_ZOOM) return false;

  const projection = map.getProjection?.();
  if (projection?.type && projection.type !== "mercator") return false;

  const center = map.getCenter();
  return (
    center.lng >= GERMANY_BOUNDS.west &&
    center.lng <= GERMANY_BOUNDS.east &&
    center.lat >= GERMANY_BOUNDS.south &&
    center.lat <= GERMANY_BOUNDS.north
  );
}
