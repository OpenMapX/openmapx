import { type Client, createClient } from "@hey-api/client-fetch";
import {
  type Itinerary,
  type Leg,
  type Alert as MotisAlert,
  trip as motisTrip,
  type Place,
  stoptimes,
} from "@motis-project/motis-client";
import { USER_AGENT_TRANSIT } from "@openmapx/core";
import {
  createManifestAttribution,
  type IntegrationContext,
  type RealtimeProvider,
  type TripUpdate,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { mapMotisAlert, mapMotisAlertSeverity } from "@openmapx/mobility-core/motis-alerts";
import { withAttribution } from "@openmapx/mobility-core/result";

const attribution = createManifestAttribution();

import type { Attribution } from "@openmapx/mobility-core/attribution";

/**
 * Final fallback when neither the `motis` service registry entry nor
 * `ctx.config.endpoint` resolves to a URL. Matches the convention used by
 * `transit-motis-local`, `geocoding-motis`, and `services/data-manager`'s
 * promote stage so a single deployment-wide `MOTIS_URL` env var threads
 * through every consumer of the local instance.
 */
const FALLBACK_MOTIS_URL = "http://localhost:8081";
const TRANSITOUS_URL = "https://api.transitous.org";
const TIMEOUT_MS = 8_000;
const PROVIDER_ID = "live-transit-motis";
const SOURCE_ID = "motis-rt";
const ALERT_PREFIX = "mr:";

/**
 * Resolution order: service registry → manifest config → MOTIS_URL env →
 * localhost fallback. Lets ops pick whichever surface fits their topology
 * without touching the integration code.
 */
function resolveMotisUrl(ctx: IntegrationContext): string {
  const resolved = ctx.getRequiredService?.("motis");
  return (
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    process.env.MOTIS_URL ??
    FALLBACK_MOTIS_URL
  );
}

// MOTIS declares array query params as `explode: false` (comma-joined in one
// param) and honours only the FIRST occurrence of a repeated param, so the
// client-fetch default (`explode: true`) would drop all but the first value of
// any multi-value list. Serialise arrays comma-joined to match the spec.
const QUERY_SERIALIZER = { array: { explode: false, style: "form" } } as const;

function makeClient(baseUrl: string): Client {
  const c = createClient({
    baseUrl,
    headers: { "User-Agent": USER_AGENT_TRANSIT },
    querySerializer: QUERY_SERIALIZER,
  });
  c.interceptors.request.use(
    (request) => new Request(request, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
  );
  return c;
}

// Two instances so realtime is queried against the SAME MOTIS that produced the
// id: `mo:` ids come from the cloud Transitous instance, everything else (`ms:`)
// from the deployment's self-hosted MOTIS. Routing by prefix (not reachability)
// is required — a `mo:` trip simply does not exist in the local instance, and
// vice versa — and mirrors transit-motis's getVehicleJourney prefix handling.
const localClient = makeClient(FALLBACK_MOTIS_URL);
const transitousClient = makeClient(TRANSITOUS_URL);

function routeForId(id: string): { client: Client; attribution: Attribution[] } {
  if (id.startsWith("mo:")) {
    const attr = attribution.bySource("transitous");
    return { client: transitousClient, attribution: attr ? [attr] : [] };
  }
  const attr = attribution.bySource("motis-rt");
  return { client: localClient, attribution: attr ? [attr] : [] };
}

/** MOTIS id prefixes the local + cloud + RT providers all share. */
const MOTIS_ID_PREFIX_RE = /^(ms:|mo:|mr:)/;

function stripPrefix(id: string): string {
  return id.replace(MOTIS_ID_PREFIX_RE, "");
}

/**
 * Walk an itinerary's legs and return the Place whose stopId matches `target`
 * (after MOTIS prefix strip). Searches `from`, `to`, and `intermediateStops`
 * — the same shape MOTIS returns from its `trip` endpoint.
 */
function findPlaceForStop(itinerary: Itinerary, target: string): Place | undefined {
  const stripped = stripPrefix(target);
  for (const leg of itinerary.legs ?? []) {
    if (leg.from?.stopId === stripped) return leg.from;
    if (leg.to?.stopId === stripped) return leg.to;
    for (const stop of leg.intermediateStops ?? []) {
      if (stop.stopId === stripped) return stop;
    }
  }
  return undefined;
}

/**
 * Build a structured {@link TripUpdate} from a MOTIS Itinerary.
 *
 * When `stopId` is supplied we resolve the matching Place inside the trip
 * and derive the delta from its `scheduledDeparture`/`departure` (falling
 * back to `scheduledArrival`/`arrival` for terminus stops). Otherwise we
 * use the first leg's departure point as a trip-level summary — this
 * matches the convention the orchestrator's enrichment helper expects when
 * the caller only knows the trip id.
 */
function deltaFromItinerary(
  itinerary: Itinerary,
  tripId: string,
  stopId?: string,
): TripUpdate | null {
  const place: Place | undefined = stopId
    ? findPlaceForStop(itinerary, stopId)
    : itinerary.legs?.[0]?.from;
  const leg: Leg | undefined = itinerary.legs?.[0];
  if (!place && !leg) return null;

  const scheduledAt = place?.scheduledDeparture ?? place?.scheduledArrival;
  const actualAt = place?.departure ?? place?.arrival;
  const platform = place?.track ?? undefined;
  const stopCancelled = place?.cancelled ?? false;
  const legCancelled = leg?.cancelled ?? false;
  const canceled = stopCancelled || legCancelled;

  let expectedAt: string | undefined;
  let delaySeconds: number | undefined;
  if (scheduledAt && actualAt && actualAt !== scheduledAt) {
    const diff = (new Date(actualAt).getTime() - new Date(scheduledAt).getTime()) / 1000;
    if (Number.isFinite(diff)) {
      delaySeconds = Math.round(diff);
      expectedAt = actualAt;
    }
  }

  // Avoid a misleading "found it but nothing to say" delta. Return null so
  // the orchestrator can fall through to the next provider.
  if (!expectedAt && delaySeconds === undefined && !canceled && !platform) return null;

  return {
    tripId,
    ...(expectedAt ? { expectedAt } : {}),
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    ...(canceled ? { canceled: true } : {}),
    ...(platform ? { platform } : {}),
  };
}

export function setup(ctx: IntegrationContext): void {
  attribution.set(ctx.manifest.dataSources ?? []);
  localClient.setConfig({
    baseUrl: resolveMotisUrl(ctx),
    headers: { "User-Agent": USER_AGENT_TRANSIT },
  });
  transitousClient.setConfig({
    baseUrl: (ctx.config.transitousUrl as string | undefined) || TRANSITOUS_URL,
    headers: { "User-Agent": USER_AGENT_TRANSIT },
  });

  const provider: RealtimeProvider = {
    id: PROVIDER_ID,
    coverage: { all: true },
    priority: 12,
    attribution: attribution.all(),
    capabilities: {
      vehiclePositions: false,
      alerts: { byStop: true, byRoute: false, byBbox: false },
      tripUpdates: true,
    },
    async getAlertsForStop(stopId) {
      const { client, attribution: attr } = routeForId(stopId);
      try {
        const { data } = await stoptimes({
          client,
          query: { stopId: stripPrefix(stopId), n: 0, window: 0, withAlerts: true },
        });
        const motisAlerts: MotisAlert[] = data?.place?.alerts ?? [];
        const mapped = motisAlerts.map((alert, index) =>
          mapMotisAlert(alert, {
            index,
            idPrefix: ALERT_PREFIX,
            providers: [SOURCE_ID],
            affectedStopIds: [stopId],
          }),
        );
        return withAttribution(mapped, attr, freshnessNow({ hasRealtimeData: true }));
      } catch {
        return withAttribution([], attr, freshnessNow({ hasRealtimeData: true }));
      }
    },
    async getTripUpdate(tripId, stopId) {
      // We can only resolve MOTIS-prefixed trip ids. For anything else
      // (e.g. db-hafas:, entur:) return null so the orchestrator can move on
      // to the next realtime provider without burning a HTTP round-trip.
      if (!MOTIS_ID_PREFIX_RE.test(tripId)) {
        return withAttribution(null, attribution.all(), freshnessNow({ hasRealtimeData: true }));
      }
      const { client, attribution: attr } = routeForId(tripId);
      try {
        const { data } = await motisTrip({
          client,
          query: { tripId: stripPrefix(tripId) },
        });
        const itinerary = data as Itinerary | undefined;
        const delta = itinerary ? deltaFromItinerary(itinerary, tripId, stopId) : null;
        return withAttribution(delta, attr, freshnessNow({ hasRealtimeData: true }));
      } catch {
        return withAttribution(null, attr, freshnessNow({ hasRealtimeData: true }));
      }
    },
  };

  ctx.registerRealtimeProvider(provider);
}

export const __testing = {
  deltaFromItinerary,
  findPlaceForStop,
  mapMotisAlert,
  mapMotisAlertSeverity,
  resolveMotisUrl,
  routeForId,
  stripPrefix,
  localClient,
  transitousClient,
};
