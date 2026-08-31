import {
  type Itinerary,
  type Leg,
  type Alert as MotisAlert,
  trip as motisTrip,
  type Place,
  stoptimes,
} from "@motis-project/motis-client";
import { type BBox, USER_AGENT_TRANSIT } from "@openmapx/core";
import {
  createManifestAttribution,
  type IntegrationContext,
  type RealtimeProvider,
  type TripUpdate,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { mapMotisAlert, mapMotisAlertSeverity } from "@openmapx/mobility-core/motis-alerts";
import { createMotisInstance, type MotisInstance } from "@openmapx/mobility-core/motis-client";
import { getMotisVehicleRadar } from "@openmapx/mobility-core/motis-radar";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { LiveTransitVehicle } from "@openmapx/mobility-core/transit";

const attribution = createManifestAttribution();

/**
 * Final fallback when neither the `motis` service registry entry nor
 * `ctx.config.endpoint` resolves to a URL. Matches the convention used by
 * `transit-motis-local`, `geocoding-motis`, and `services/data-manager`'s
 * promote stage so a single deployment-wide `MOTIS_URL` env var threads
 * through every consumer of the local instance.
 */
const FALLBACK_MOTIS_URL = "http://localhost:8081";
const TRANSITOUS_URL = "https://api.transitous.org";
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

interface LiveTransitMotisInstances {
  local: MotisInstance;
  transitous: MotisInstance;
}

function createLiveTransitMotisInstances(ctx: IntegrationContext): LiveTransitMotisInstances {
  return {
    local: createMotisInstance({
      baseUrl: resolveMotisUrl(ctx),
      prefix: "ms:",
      provider: "ms",
      userAgent: USER_AGENT_TRANSIT,
    }),
    transitous: createMotisInstance({
      baseUrl: (ctx.config.transitousUrl as string | undefined)?.trim() || TRANSITOUS_URL,
      prefix: "mo:",
      provider: "mo",
      userAgent: USER_AGENT_TRANSIT,
    }),
  };
}

function routeForId(
  id: string,
  instances: LiveTransitMotisInstances,
): { client: MotisInstance["client"]; attribution: Attribution[] } {
  if (id.startsWith("mo:")) {
    const attr = attribution.bySource("transitous");
    return { client: instances.transitous.client, attribution: attr ? [attr] : [] };
  }
  const attr = attribution.bySource("motis-rt");
  return { client: instances.local.client, attribution: attr ? [attr] : [] };
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

/**
 * Schedule-based (realtime-aware) vehicle positions from MOTIS `map/trips`: for
 * every trip currently between two stops in the viewport, MOTIS returns the leg
 * shape + times and the vehicle is interpolated to "now". These are `interpolated`
 * positions — the overlay renders them distinctly and prefers a real GPS fix for
 * the same trip. On the self-hosted instance (`ms:`), where most feeds publish no
 * GPS at all, this is the only way to show moving vehicles.
 */
async function getInterpolatedVehicles(
  instance: MotisInstance,
  bbox: BBox,
): Promise<LiveTransitVehicle[]> {
  const vehicles = await getMotisVehicleRadar(instance, bbox);
  return vehicles.map((vehicle) => ({
    ...vehicle,
    sourceId: SOURCE_ID,
    mode: vehicle.mode ?? "bus",
    displayLabel: vehicle.label ?? "Transit",
    positionKind: "interpolated",
  }));
}

export function setup(ctx: IntegrationContext): void {
  const instances = createLiveTransitMotisInstances(ctx);
  ctx.onActivate(() => attribution.set(ctx.manifest.dataSources ?? []));

  const provider: RealtimeProvider = {
    id: PROVIDER_ID,
    coverage: { all: true },
    priority: 12,
    attribution: attribution.all(),
    capabilities: {
      vehiclePositions: true,
      alerts: { byStop: true, byRoute: false, byBbox: false },
      tripUpdates: true,
    },
    async getVehiclePositions(bbox: BBox) {
      const attr = attribution.bySource(SOURCE_ID);
      const data = await getInterpolatedVehicles(instances.local, bbox);
      return withAttribution(data, attr ? [attr] : [], freshnessNow({ hasRealtimeData: true }));
    },
    async getAlertsForStop(stopId) {
      const { client, attribution: attr } = routeForId(stopId, instances);
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
      const { client, attribution: attr } = routeForId(tripId, instances);
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
  createLiveTransitMotisInstances,
  resolveMotisUrl,
  routeForId,
  stripPrefix,
};
