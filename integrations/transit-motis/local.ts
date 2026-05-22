import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stops } from "@motis-project/motis-client";
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as motis from "./adapter.js";
import { ATTRIBUTION_TRANSITOUS } from "./attributions.js";
import {
  type MotisInstance,
  motisLocalInstance,
  setMotisLocalUrl,
  transitousInstance,
} from "./instances.js";

// Populated by setupLocal(ctx); default matches pre-config-cascade behaviour.
let LICENSE_FILE = join(process.cwd(), "../../infra/docker/data/motis-data", "license.json");

let cachedData: unknown[] | null = null;
let cachedMtime = 0;
let cachedLocalReachable = false;
let cachedLocalReachableAt = 0;

const LOCAL_REACHABILITY_TTL_MS = 15_000;

const ATTRIBUTION_LOCAL: Attribution[] = [
  {
    sourceId: "transitous",
    name: "MOTIS (self-hosted)",
    url: "https://github.com/motis-project/motis",
    spdxLicense: "MIT",
    licenseUrl: "https://github.com/motis-project/motis",
  },
];

function wrapLocal<T>(data: T) {
  return withAttribution(data, ATTRIBUTION_LOCAL, freshnessNow());
}
function wrapLocalRT<T>(data: T) {
  return withAttribution(data, ATTRIBUTION_LOCAL, freshnessNow({ hasRealtimeData: true }));
}
function wrapTransitous<T>(data: T) {
  return withAttribution(data, ATTRIBUTION_TRANSITOUS, freshnessNow());
}
function wrapTransitousRT<T>(data: T) {
  return withAttribution(data, ATTRIBUTION_TRANSITOUS, freshnessNow({ hasRealtimeData: true }));
}

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

async function isMotisReachableCached(): Promise<boolean> {
  if (Date.now() - cachedLocalReachableAt < LOCAL_REACHABILITY_TTL_MS) {
    return cachedLocalReachable;
  }
  cachedLocalReachable = await isMotisReachable();
  cachedLocalReachableAt = Date.now();
  return cachedLocalReachable;
}

function withPrefix(id: string, prefix: "ms:" | "mo:"): string {
  return `${prefix}${id.replace(/^(ms:|mo:)/, "")}`;
}

function resolveDateTime(departureTime?: string): { date: string; time: string } {
  const now = new Date();
  return {
    date: departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10),
    time: departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19),
  };
}

async function planWithInstance(
  instance: MotisInstance,
  params: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    departureTime?: string;
  },
) {
  const { date, time } = resolveDateTime(params.departureTime);
  return motis.planTrip(
    instance,
    params.from.lat,
    params.from.lng,
    params.to.lat,
    params.to.lng,
    date,
    time,
  );
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

export function setupLocal(ctx: IntegrationContext): void {
  // Resolve local MOTIS URL from the service registry if available.
  const resolved = ctx.getRequiredService("motis");
  const motisUrl =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "http://localhost:8081";
  setMotisLocalUrl(motisUrl);
  cachedLocalReachable = false;
  cachedLocalReachableAt = 0;

  const dataDir =
    (ctx.config.dataDir as string | undefined) ??
    join(process.cwd(), "../../infra/docker/data/motis-data");
  LICENSE_FILE = join(dataDir, "license.json");
  cachedData = null;
  cachedMtime = 0;

  // Register local-first MOTIS provider.
  // For bbox/search/plan we only expose this provider to avoid fan-out to both local + cloud.
  ctx.registerTransitProvider({
    id: "transit-motis-local",
    prefix: "ms:",
    coverage: { all: true },
    priority: 1,
    attribution: ATTRIBUTION_LOCAL,
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: false,
        search: true,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: true,
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      const deg = radiusMeters / 111_320;
      if (await isMotisReachableCached()) {
        const local = await motis.getStops(motisLocalInstance, [
          lng - deg,
          lat - deg,
          lng + deg,
          lat + deg,
        ]);
        if (local.length > 0) return wrapLocal(local);
      }
      return wrapTransitous(
        await motis.getStops(transitousInstance, [lng - deg, lat - deg, lng + deg, lat + deg]),
      );
    },
    async getStop(id) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getStopById(motisLocalInstance, localId);
        if (local) return wrapLocal(local);
      }
      return wrapTransitous(await motis.getStopById(transitousInstance, cloudId));
    },
    async getDepartures(id, min) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getDepartures(motisLocalInstance, localId, min);
        if (local.length > 0) return wrapLocalRT(local);
      }
      return wrapTransitousRT(await motis.getDepartures(transitousInstance, cloudId, min));
    },
    async getArrivals(id, min) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getArrivals(motisLocalInstance, localId, min);
        if (local.length > 0) return wrapLocalRT(local);
      }
      return wrapTransitousRT(await motis.getArrivals(transitousInstance, cloudId, min));
    },
    async searchStopsByName(q, limit) {
      const lim = limit ?? 10;
      if (await isMotisReachableCached()) {
        const local = await motis.searchByName(motisLocalInstance, q, lim);
        if (local.length > 0) return wrapLocal(local);
      }
      return wrapTransitous(await motis.searchByName(transitousInstance, q, lim));
    },
    async planTrip(params) {
      if (await isMotisReachableCached()) {
        const local = await planWithInstance(motisLocalInstance, params);
        if (local?.itineraries?.length) return wrapLocalRT([local]);
      }
      const cloudPlan = await planWithInstance(transitousInstance, params);
      return wrapTransitousRT(cloudPlan ? [{ ...cloudPlan, provider: "mo" }] : []);
    },
    async getVehicleJourney(tripId) {
      const localId = withPrefix(tripId, "ms:");
      const cloudId = withPrefix(tripId, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getTrip(motisLocalInstance, localId);
        if (local) return wrapLocalRT(local);
      }
      return wrapTransitousRT(await motis.getTrip(transitousInstance, cloudId));
    },
  });

  // Register dynamic attribution endpoint
  ctx.registerRoute("GET", "/attribution", async (_req, res) => {
    res.send(loadAttribution());
  });
}
