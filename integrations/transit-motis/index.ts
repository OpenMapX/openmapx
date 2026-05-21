import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stops } from "@motis-project/motis-client";
import type { IntegrationContext } from "@openmapx/integration-framework";
import * as motis from "./adapter.js";
import {
  configureTransitous,
  type MotisInstance,
  motisLocalInstance,
  setMotisLocalUrl,
  transitousInstance,
} from "./instances.js";

// Populated by setup(ctx); default matches pre-config-cascade behaviour.
let LICENSE_FILE = join(process.cwd(), "../../infra/docker/data/motis-data", "license.json");

let cachedData: unknown[] | null = null;
let cachedMtime = 0;
let cachedLocalReachable = false;
let cachedLocalReachableAt = 0;

const LOCAL_REACHABILITY_TTL_MS = 15_000;

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

export async function setup(ctx: IntegrationContext): Promise<void> {
  // Resolve local MOTIS URL from the service registry if available.
  const resolved = ctx.getRequiredService("motis");
  const motisUrl =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "http://localhost:8081";
  setMotisLocalUrl(motisUrl);
  cachedLocalReachable = false;
  cachedLocalReachableAt = 0;

  configureTransitous({
    url: ctx.config.transitousUrl as string | undefined,
    userAgent: ctx.config.transitousUserAgent as string | undefined,
  });

  const dataDir =
    (ctx.config.dataDir as string | undefined) ??
    join(process.cwd(), "../../infra/docker/data/motis-data");
  LICENSE_FILE = join(dataDir, "license.json");
  cachedData = null;
  cachedMtime = 0;

  // Register local-first MOTIS provider.
  // For bbox/search/plan we only expose this provider to avoid fan-out to both local + cloud.
  ctx.registerProvider("transit", {
    id: "transit-motis-local",
    prefix: "ms:",
    coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
    priority: 2,
    async getStopsNearby(lat: number, lng: number, radiusMeters: number) {
      const deg = radiusMeters / 111_320;
      if (await isMotisReachableCached()) {
        const local = await motis.getStops(motisLocalInstance, [
          lng - deg,
          lat - deg,
          lng + deg,
          lat + deg,
        ]);
        if (local.length > 0) return local;
      }
      return motis.getStops(transitousInstance, [lng - deg, lat - deg, lng + deg, lat + deg]);
    },
    async getStop(id: string) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getStopById(motisLocalInstance, localId);
        if (local) return local;
      }
      return motis.getStopById(transitousInstance, cloudId);
    },
    async getDepartures(id: string, min: number) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getDepartures(motisLocalInstance, localId, min);
        if (local.length > 0) return local;
      }
      return motis.getDepartures(transitousInstance, cloudId, min);
    },
    async getArrivals(id: string, min: number) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getArrivals(motisLocalInstance, localId, min);
        if (local.length > 0) return local;
      }
      return motis.getArrivals(transitousInstance, cloudId, min);
    },
    async searchByName(q: string, limit: number) {
      if (await isMotisReachableCached()) {
        const local = await motis.searchByName(motisLocalInstance, q, limit);
        if (local.length > 0) return local;
      }
      return motis.searchByName(transitousInstance, q, limit);
    },
    async planTrip(params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
    }) {
      if (await isMotisReachableCached()) {
        const local = await planWithInstance(motisLocalInstance, params);
        if (local?.itineraries?.length) return local;
      }
      const cloudPlan = await planWithInstance(transitousInstance, params);
      return cloudPlan ? { ...cloudPlan, provider: "mo" } : null;
    },
    async getVehicleJourney(tripId: string) {
      const localId = withPrefix(tripId, "ms:");
      const cloudId = withPrefix(tripId, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getTrip(motisLocalInstance, localId);
        if (local) return local;
      }
      return motis.getTrip(transitousInstance, cloudId);
    },
  });

  // Register dynamic attribution endpoint
  ctx.registerRoute("GET", "/attribution", async (_req, res) => {
    res.send(loadAttribution());
  });

  // Keep a Transitous provider for attribution + follow-up lookups of `mo:` IDs.
  // Intentionally do not expose nearby/search/plan here to avoid orchestrator fan-out.
  ctx.registerProvider("transit", {
    id: "transit-motis-transitous",
    prefix: "mo:",
    coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
    priority: 3,
    getStop: (id: string) => motis.getStopById(transitousInstance, withPrefix(id, "mo:")),
    getDepartures: (id: string, min: number) =>
      motis.getDepartures(transitousInstance, withPrefix(id, "mo:"), min),
    getArrivals: (id: string, min: number) =>
      motis.getArrivals(transitousInstance, withPrefix(id, "mo:"), min),
    getVehicleJourney: (tripId: string) =>
      motis.getTrip(transitousInstance, withPrefix(tripId, "mo:")),
  });
}
