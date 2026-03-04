import type { TrafficProvider, TrafficTile } from "./traffic.provider";
import { TrafficProviderHttpError } from "./traffic.provider";

const TOMTOM_TRAFFIC_BASE_URL = process.env.TOMTOM_TRAFFIC_URL ?? "https://api.tomtom.com";
const TOMTOM_TRAFFIC_STYLE = process.env.TOMTOM_TRAFFIC_STYLE ?? "relative-delay";
const TOMTOM_TRAFFIC_VERSION = process.env.TOMTOM_TRAFFIC_VERSION ?? "4";
const TOMTOM_TRAFFIC_TILE_SIZE = process.env.TOMTOM_TRAFFIC_TILE_SIZE ?? "256";
const TOMTOM_TRAFFIC_THICKNESS = process.env.TOMTOM_TRAFFIC_THICKNESS;

function getTomTomTrafficKey(): string {
  const key = process.env.TOMTOM_TRAFFIC_KEY;
  if (!key) {
    throw new Error("TOMTOM_TRAFFIC_KEY env var is required for TomTom traffic tiles");
  }
  return key;
}

function buildFlowTileUrl(z: number, x: number, y: number): URL {
  const base = TOMTOM_TRAFFIC_BASE_URL.replace(/\/+$/, "");
  const url = new URL(
    `${base}/traffic/map/${TOMTOM_TRAFFIC_VERSION}/tile/flow/${TOMTOM_TRAFFIC_STYLE}/${z}/${x}/${y}.png`,
  );
  url.searchParams.set("key", getTomTomTrafficKey());
  url.searchParams.set("tileSize", TOMTOM_TRAFFIC_TILE_SIZE);
  if (TOMTOM_TRAFFIC_THICKNESS) {
    url.searchParams.set("thickness", TOMTOM_TRAFFIC_THICKNESS);
  }
  return url;
}

async function fetchFlowTile(z: number, x: number, y: number): Promise<TrafficTile> {
  const res = await fetch(buildFlowTileUrl(z, x, y), {
    headers: {
      Accept: "image/png,image/*;q=0.8,*/*;q=0.5",
      "User-Agent": "OpenMapX/1.0",
    },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    const detail = errorBody.trim().slice(0, 300);
    throw new TrafficProviderHttpError(
      `TomTom traffic flow tile error ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }

  return {
    contentType: res.headers.get("content-type") ?? "image/png",
    cacheControl: res.headers.get("cache-control") ?? "public, max-age=30, s-maxage=30",
    bytes: await res.arrayBuffer(),
  };
}

export const tomtomTrafficService: TrafficProvider = {
  async getFlowTile(z: number, x: number, y: number): Promise<TrafficTile> {
    return fetchFlowTile(z, x, y);
  },
};
