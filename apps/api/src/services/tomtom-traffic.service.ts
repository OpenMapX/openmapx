import { USER_AGENT } from "@openmapx/core";
import { createBoundedBinaryProxyStream, MAX_RASTER_TILE_BYTES } from "@openmapx/core/server";
import { envString } from "@openmapx/core/server-env";
import { discardUpstreamResponse } from "../utils/upstream-response.js";
import type { TrafficProvider, TrafficTile } from "./traffic.provider";
import { TrafficProviderHttpError } from "./traffic.provider";

const TOMTOM_TRAFFIC_BASE_URL = envString("TOMTOM_TRAFFIC_URL", "https://api.tomtom.com");
const TOMTOM_TRAFFIC_STYLE = envString("TOMTOM_TRAFFIC_STYLE", "relative-delay");
const TOMTOM_TRAFFIC_VERSION = envString("TOMTOM_TRAFFIC_VERSION", "4");
const TOMTOM_TRAFFIC_TILE_SIZE = envString("TOMTOM_TRAFFIC_TILE_SIZE", "256");
const TOMTOM_TRAFFIC_THICKNESS = process.env.TOMTOM_TRAFFIC_THICKNESS;
const TOMTOM_TRAFFIC_TIMEOUT_MS = 15_000;

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

async function fetchFlowTile(
  z: number,
  x: number,
  y: number,
  callerSignal?: AbortSignal,
): Promise<TrafficTile> {
  const timeoutSignal = AbortSignal.timeout(TOMTOM_TRAFFIC_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(buildFlowTileUrl(z, x, y), {
    headers: {
      Accept: "image/png,application/json;q=0.8",
      "User-Agent": USER_AGENT,
    },
    redirect: "error",
    signal,
  });

  if (!res.ok) {
    discardUpstreamResponse(res);
    throw new TrafficProviderHttpError(`TomTom traffic flow tile error ${res.status}`, res.status);
  }

  const proxy = createBoundedBinaryProxyStream(res, {
    maxBytes: MAX_RASTER_TILE_BYTES,
    allowedContentTypes: ["image/png"],
    label: "TomTom traffic flow tile",
  });
  return {
    contentType: proxy.contentType,
    cacheControl: res.headers.get("cache-control") ?? "public, max-age=30, s-maxage=30",
    body: proxy.body,
  };
}

export const tomtomTrafficService: TrafficProvider = {
  async getFlowTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<TrafficTile> {
    return fetchFlowTile(z, x, y, signal);
  },
};
