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
  captureTransitContributors,
  createManifestAttribution,
  type IntegrationContext,
  type RealtimeProvider,
  type TripUpdate,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { mapMotisAlert, mapMotisAlertSeverity } from "@openmapx/mobility-core/motis-alerts";
import { createMotisInstance, type MotisInstance } from "@openmapx/mobility-core/motis-client";
import { wrapMotisWithFeedAttribution } from "@openmapx/mobility-core/motis-contributors";
import { getMotisVehicleRadar } from "@openmapx/mobility-core/motis-radar";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { LiveTransitVehicle } from "@openmapx/mobility-core/transit";

const attribution = createManifestAttribution();

const TRANSITOUS_URL = "https://api.transitous.org";
const PROVIDER_ID = "live-transit-motis";
const SOURCE_ID = "motis-rt";
const ALERT_PREFIX = "mr:";

interface LiveTransitMotisInstances {
  /** The self-hosted MOTIS; absent when the deployment runs on Transitous. */
  local?: MotisInstance;
  transitous: MotisInstance;
}

function createLiveTransitMotisInstances(ctx: IntegrationContext): LiveTransitMotisInstances {
  // The self-hosted MOTIS, if any: the service, the `endpoint` setting or
  // MOTIS_URL. Without one, live data comes from Transitous directly.
  const localUrl = ctx.resolvePlatformEndpoint("motis")?.url;
  return {
    ...(localUrl
      ? {
          local: createMotisInstance({
            baseUrl: localUrl,
            prefix: "ms:",
            provider: "ms",
            userAgent: USER_AGENT_TRANSIT,
          }),
        }
      : {}),
    transitous: createMotisInstance({
      baseUrl: ctx.resolvePlatformEndpoint("transitous")?.url ?? TRANSITOUS_URL,
      prefix: "mo:",
      provider: "mo",
      userAgent: USER_AGENT_TRANSIT,
    }),
  };
}

function routeForId(
  id: string,
  instances: LiveTransitMotisInstances,
): { client: MotisInstance["client"]; sourceId: string; attribution: Attribution[] } {
  const local = id.startsWith("mo:") ? undefined : instances.local;
  const sourceId = local ? SOURCE_ID : "transitous";
  const attr = attribution.bySource(sourceId);
  return {
    client: (local ?? instances.transitous).client,
    sourceId,
    attribution: attr ? [attr] : [],
  };
}

/** The instance serving interpolated vehicles, and the source it credits. */
function vehicleSource(instances: LiveTransitMotisInstances): {
  instance: MotisInstance;
  sourceId: string;
} {
  return instances.local
    ? { instance: instances.local, sourceId: SOURCE_ID }
    : { instance: instances.transitous, sourceId: "transitous" };
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
  sourceId: string,
  bbox: BBox,
): Promise<LiveTransitVehicle[]> {
  const vehicles = await getMotisVehicleRadar(instance, bbox);
  return vehicles.map((vehicle) => ({
    ...vehicle,
    sourceId,
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
      const { instance, sourceId } = vehicleSource(instances);
      const attr = attribution.bySource(sourceId);
      const data = await getInterpolatedVehicles(instance, sourceId, bbox);
      if (sourceId === SOURCE_ID)
        return wrapMotisWithFeedAttribution(data, ctx.attributionIndex, true);
      return withAttribution(
        captureTransitContributors(data, attr ? [attr] : []),
        attr ? [attr] : [],
        freshnessNow({ hasRealtimeData: true }),
      );
    },
    async getAlertsForStop(stopId) {
      const { client, sourceId, attribution: attr } = routeForId(stopId, instances);
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
            providers: [sourceId],
            affectedStopIds: [stopId],
          }),
        );
        if (sourceId === SOURCE_ID)
          return wrapMotisWithFeedAttribution(mapped, ctx.attributionIndex, true);
        return withAttribution(
          captureTransitContributors(mapped, attr),
          attr,
          freshnessNow({ hasRealtimeData: true }),
        );
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
      const { client, sourceId, attribution: attr } = routeForId(tripId, instances);
      try {
        const { data } = await motisTrip({
          client,
          query: { tripId: stripPrefix(tripId) },
        });
        const itinerary = data as Itinerary | undefined;
        const delta = itinerary ? deltaFromItinerary(itinerary, tripId, stopId) : null;
        if (sourceId === SOURCE_ID)
          return wrapMotisWithFeedAttribution(delta, ctx.attributionIndex, true);
        return withAttribution(
          captureTransitContributors(delta, attr),
          attr,
          freshnessNow({ hasRealtimeData: true }),
        );
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
  routeForId,
  vehicleSource,
  stripPrefix,
};
