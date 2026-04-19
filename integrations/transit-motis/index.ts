import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stops } from "@motis-project/motis-client";
import type { IntegrationContext } from "@openmapx/core";
import * as motis from "./adapter.js";
import {
  configureTransitous,
  motisLocalInstance,
  setMotisLocalUrl,
  transitousInstance,
} from "./instances.js";

// Populated by setup(ctx); default matches pre-config-cascade behaviour.
let LICENSE_FILE = join(process.cwd(), "../../infra/docker/data/motis", "license.json");

let cachedData: unknown[] | null = null;
let cachedMtime = 0;

function loadAttribution(): unknown[] {
  if (!existsSync(LICENSE_FILE)) return [];
  const mtime = statSync(LICENSE_FILE).mtimeMs;
  if (cachedData && mtime === cachedMtime) return cachedData;
  try {
    cachedData = JSON.parse(readFileSync(LICENSE_FILE, "utf-8"));
    cachedMtime = mtime;
    return cachedData ?? [];
  } catch {
    return [];
  }
}

/** Check if the local MOTIS instance is reachable. */
async function isMotisReachable(): Promise<boolean> {
  try {
    const { response } = await stops({
      client: motisLocalInstance.client,
      query: { min: "0,0", max: "0.01,0.01" },
    });
    return response.ok || (response.status >= 400 && response.status < 500);
  } catch {
    return false;
  }
}

interface FeedEntry {
  filename?: string;
  human_name?: string;
  source?: string;
  spdx_license_identifier?: string;
  license_url?: string;
  publisher?: { name?: string; url?: string };
}

/**
 * Build a provider attribution map from MOTIS license.json keyed by feed tag.
 * Feed tags match the format MOTIS uses in its `source` field (e.g. "de_DELFI").
 */
export function getFeedProviders(): Record<
  string,
  { label: string; url: string; license?: string; licenseUrl?: string }
> {
  const feeds = loadAttribution() as FeedEntry[];
  const result: Record<
    string,
    { label: string; url: string; license?: string; licenseUrl?: string }
  > = {};
  for (const feed of feeds) {
    if (!feed.filename) continue;
    const tag = feed.filename.replace(/\.(gtfs|netex)\.zip$/, "");
    if (!tag) continue;
    result[tag] = {
      label: feed.human_name ?? tag,
      url: feed.publisher?.url ?? feed.source ?? "",
      license: feed.spdx_license_identifier,
      licenseUrl: feed.license_url,
    };
  }
  return result;
}

export async function setup(ctx: IntegrationContext): Promise<void> {
  // Resolve local MOTIS URL from the service registry if available.
  const resolved = ctx.getRequiredService("motis");
  const motisUrl =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "http://localhost:8081";
  setMotisLocalUrl(motisUrl);

  configureTransitous({
    url: ctx.config.transitousUrl as string | undefined,
    userAgent: ctx.config.transitousUserAgent as string | undefined,
  });

  const dataDir =
    (ctx.config.dataDir as string | undefined) ??
    join(process.cwd(), "../../infra/docker/data/motis");
  LICENSE_FILE = join(dataDir, "license.json");
  cachedData = null;
  cachedMtime = 0;

  // Register Transitous (cloud MOTIS) as a transit provider
  ctx.registerProvider("transit", {
    id: "transit-motis-transitous",
    prefix: "mo:",
    coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
    priority: 3,
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) => {
      const deg = radiusMeters / 111_320;
      return motis.getStops(transitousInstance, [lng - deg, lat - deg, lng + deg, lat + deg]);
    },
    getStop: (id: string) => motis.getStopById(transitousInstance, id),
    getDepartures: (id: string, min: number) => motis.getDepartures(transitousInstance, id, min),
    getArrivals: (id: string, min: number) => motis.getArrivals(transitousInstance, id, min),
    searchByName: (q: string, limit: number) => motis.searchByName(transitousInstance, q, limit),
    async planTrip(params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
    }) {
      const now = new Date();
      const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
      const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
      return motis.planTrip(
        transitousInstance,
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
      );
    },
  });

  // Register dynamic attribution endpoint
  ctx.registerRoute("GET", "/attribution", async (_req, res) => {
    res.send(loadAttribution());
  });

  // Register local MOTIS if available
  if (await isMotisReachable()) {
    ctx.registerProvider("transit", {
      id: "transit-motis-local",
      prefix: "ms:",
      coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
      priority: 2,
      getStopsNearby: (lat: number, lng: number, radiusMeters: number) => {
        const deg = radiusMeters / 111_320;
        return motis.getStops(motisLocalInstance, [lng - deg, lat - deg, lng + deg, lat + deg]);
      },
      getStop: (id: string) => motis.getStopById(motisLocalInstance, id),
      getDepartures: (id: string, min: number) => motis.getDepartures(motisLocalInstance, id, min),
      getArrivals: (id: string, min: number) => motis.getArrivals(motisLocalInstance, id, min),
      searchByName: (q: string, limit: number) => motis.searchByName(motisLocalInstance, q, limit),
      async planTrip(params: {
        from: { lat: number; lng: number };
        to: { lat: number; lng: number };
        departureTime?: string;
      }) {
        const now = new Date();
        const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
        const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
        return motis.planTrip(
          motisLocalInstance,
          params.from.lat,
          params.from.lng,
          params.to.lat,
          params.to.lng,
          date,
          time,
        );
      },
    });
  }
}
