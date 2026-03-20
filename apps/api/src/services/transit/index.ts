import { cacheGet, cacheSet, hashKey, TTL } from "../../utils/cache.js";
import { matchToRoads } from "../../utils/road-snap.js";
import { motisProvider as motisLocal } from "../motis/index";
import { getAdapter } from "./adapters/index";
import { deduplicateStops, isTripNumber } from "./dedup";
import { providerHealth } from "./health";
import * as dbVendo from "./providers/db-vendo";
import * as gtfsLocal from "./providers/gtfs-local";
import * as hafas from "./providers/hafas";
import * as irail from "./providers/irail";
import * as mbta from "./providers/mbta";
import * as opendataCh from "./providers/opendata-ch";
import * as otp from "./providers/otp";
import * as overpass from "./providers/overpass";
import * as tfl from "./providers/tfl";
import * as transitland from "./providers/transitland";
import * as transitous from "./providers/transitous";
import {
  bboxToCenter,
  dynamicEntryFromId,
  getDynamicProviders,
  getRegionalProviders,
  providerFromId,
} from "./regions";
import type { RegistryEntry } from "./registry/types";
import type {
  BBox,
  Departure,
  Facility,
  RouteLive,
  RouteStop,
  ServiceAlert,
  TransitRoute,
  TransitStop,
  TransportMode,
  TripPlan,
  TripPlanParams,
  VehicleJourney,
  VehiclePosition,
} from "./types";

// Helpers

function hafasInstanceForProvider(provider: string): hafas.HafasInstance | null {
  return hafas.HAFAS_INSTANCES.find((i) => i.id === provider) ?? null;
}

/** Total timeout for all dynamic providers combined (don't block response) */
const DYNAMIC_TOTAL_TIMEOUT_MS = 10_000;

async function fetchDynamicStops(
  entries: RegistryEntry[],
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  if (entries.length === 0) return [];
  const healthyEntries = entries.filter((e) => providerHealth.isHealthy(`dyn:${e.id}`));
  if (healthyEntries.length === 0) return [];
  // Race each individual adapter against the shared deadline so fast
  // adapters are not discarded when slow ones time out.
  const DEADLINE_TAG = Symbol("deadline");
  const deadline = new Promise<TransitStop[]>((_, reject) =>
    setTimeout(() => reject(DEADLINE_TAG), DYNAMIC_TOTAL_TIMEOUT_MS),
  );
  const tasks = healthyEntries.map(async (entry) => {
    const adapter = getAdapter(entry.protocol);
    if (!adapter) return [];
    const healthId = `dyn:${entry.id}`;
    try {
      const stops = await Promise.race([
        adapter.getStopsNearby(entry, lat, lng, radiusMeters),
        deadline,
      ]);
      providerHealth.recordSuccess(healthId);
      return stops;
    } catch (err) {
      // Only record failure for actual errors, not shared-deadline timeouts
      if (err !== DEADLINE_TAG) {
        providerHealth.recordFailure(healthId);
      }
      return [] as TransitStop[];
    }
  });
  const results = await Promise.all(tasks);
  return results.flat();
}

async function getRegionalStops(
  provider: ReturnType<typeof getRegionalProviders>[number],
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  switch (provider) {
    case "tfl":
      return tfl.getStops(lat, lng, radiusMeters);
    case "irail":
      return irail.getStops(lat, lng, radiusMeters);
    case "mbta":
      return mbta.getStops(lat, lng, radiusMeters);
    case "opendata-ch":
      return opendataCh.getStops(lat, lng);
    case "db":
      return dbVendo.getStopsNearby(lat, lng, radiusMeters);
    case "vbb":
    case "bvg": {
      const inst = hafasInstanceForProvider(provider);
      return inst ? hafas.getStopsNearby(inst, lat, lng, radiusMeters) : [];
    }
  }
}

// Stops

export async function getStopsInBbox(bbox: BBox, modes?: TransportMode[]): Promise<TransitStop[]> {
  const key = hashKey("transit:stops", { bbox, modes });
  const cached = await cacheGet<TransitStop[]>(key);
  if (cached) return cached;

  const regionalProviders = getRegionalProviders(bbox);
  const { lat, lng, radiusMeters } = bboxToCenter(bbox);

  let stops: TransitStop[] = [];

  if (regionalProviders.length > 0) {
    const results = await Promise.allSettled(
      regionalProviders.map((p) => getRegionalStops(p, lat, lng, radiusMeters)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        stops.push(...result.value);
      }
    }
  }

  // Local GTFS feeds (priority 2) — schedule data from imported GTFS feeds
  if (stops.length === 0 && gtfsLocal.hasCoverage(bbox)) {
    try {
      const gtfsStops = await gtfsLocal.getStops(bbox);
      stops.push(...gtfsStops);
    } catch {
      // Local GTFS unavailable — fall through
    }
  }

  // Dynamic registry providers (priority 3) — fill gaps for uncovered regions.
  // Only query dynamic providers when no regional providers matched, to avoid
  // duplicate stops (e.g. a dynamic Austrian HAFAS entry overlapping with the
  // hand-crafted DB provider for the same region).
  if (regionalProviders.length === 0 && stops.length === 0) {
    const dynamicEntries = getDynamicProviders(bbox);
    if (dynamicEntries.length > 0) {
      const dynamicStops = await fetchDynamicStops(dynamicEntries, lat, lng, radiusMeters);
      stops.push(...dynamicStops);
    }
  }

  // Transitous (priority 3) — global coverage with real-time data
  if (stops.length === 0 && providerHealth.isHealthy("transitous")) {
    try {
      stops = await transitous.getStops(bbox);
      providerHealth.recordSuccess("transitous");
    } catch {
      providerHealth.recordFailure("transitous");
    }
  }

  // TransitLand + Overpass fallback (priority 4)
  if (stops.length === 0) {
    if (providerHealth.isHealthy("transitland")) {
      try {
        stops = await transitland.getStops(bbox, modes);
        providerHealth.recordSuccess("transitland");
      } catch {
        providerHealth.recordFailure("transitland");
      }
    }

    if (stops.length === 0) {
      stops = await overpass.getStops(bbox);
    }
  }

  const deduped = deduplicateStops(stops);
  await cacheSet(key, deduped, TTL.transit.stops);
  return deduped;
}

// Stop Name Search

/**
 * Query all providers for stops matching `query` by name.
 * Returns raw, non-deduplicated results.
 * Used by both `searchStopsByName` (which dedupes) and `getLinkedStops` (which keeps all).
 *
 * @param bbox - Optional bounding box to restrict which dynamic registry providers are queried.
 *   Pass the place's area bbox when doing a place-linked search to avoid getting routes from
 *   distant providers whose HAFAS instances share stop databases with DB (and therefore return
 *   "Aachen West" stops with correct coordinates but then serve their own regional routes).
 *   Omit (or pass world bbox) for a global freetext stop search.
 */
export async function fetchStopsByNameRaw(
  query: string,
  limit: number,
  bbox: BBox = [-180, -90, 180, 90],
): Promise<TransitStop[]> {
  const perProvider = Math.max(limit, 5);

  const tasks: Promise<TransitStop[]>[] = [
    ...hafas.HAFAS_INSTANCES.map((inst) => hafas.searchByName(inst, query, perProvider)),
    dbVendo.searchByName(query, perProvider),
    transitous.searchByName(query, perProvider),
    opendataCh.searchByName(query, perProvider),
    irail.searchByName(query, perProvider),
    gtfsLocal.searchByName(query, perProvider),
  ];

  const dynamicEntries = getDynamicProviders(bbox);
  for (const entry of dynamicEntries) {
    if (!providerHealth.isHealthy(`dyn:${entry.id}`)) continue;
    const adapter = getAdapter(entry.protocol);
    if (adapter?.searchByName) {
      tasks.push(adapter.searchByName(entry, query, perProvider));
    }
  }

  const results = await Promise.allSettled(
    tasks.map((t) =>
      Promise.race([
        t,
        new Promise<TransitStop[]>((resolve) => setTimeout(() => resolve([]), 5_000)),
      ]),
    ),
  );

  const allStops: TransitStop[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") allStops.push(...r.value);
  }

  return allStops.filter((s) => s.lat !== 0 && s.lng !== 0 && s.name !== "Unknown");
}

export async function searchStopsByName(query: string, limit = 5): Promise<TransitStop[]> {
  const key = hashKey("transit:stop-search", { q: query.toLowerCase() });
  const cached = await cacheGet<TransitStop[]>(key);
  if (cached) return cached.slice(0, limit);

  const raw = await fetchStopsByNameRaw(query, limit);
  const deduped = deduplicateStops(raw).slice(0, limit);
  await cacheSet(key, deduped, TTL.transit.stops);
  return deduped;
}

export async function getStop(id: string): Promise<TransitStop | null> {
  const key = hashKey("transit:stop", { id });
  const cached = await cacheGet<TransitStop>(key);
  if (cached) return cached;

  let stop: TransitStop | null = null;

  if (gtfsLocal.isGtfsLocalId(id)) {
    stop = await gtfsLocal.getStopById(id);
  } else {
    const regional = providerFromId(id);
    switch (regional) {
      case "db":
        stop = await dbVendo.getStop(id);
        break;
      case "tfl":
        stop = await tfl.getStop(id);
        break;
      case "mbta":
        stop = await mbta.getStop(id);
        break;
      case "irail":
        stop = await irail.getStopById(id);
        break;
      case "vbb":
      case "bvg":
      case "opendata-ch":
        // These providers have no getStopById — fall through to TransitLand fallback
        break;
      default:
        if (id.startsWith("mo:")) {
          stop = await transitous.getStopById(id);
        } else if (id.startsWith("ms:")) {
          stop = await motisLocal.getStopById(id);
        } else {
          // Try dynamic registry adapter (oebb:, zvv:, rsag: etc.)
          const dynEntry = dynamicEntryFromId(id);
          if (dynEntry) {
            const adapter = getAdapter(dynEntry.protocol);
            if (adapter?.getStopById) {
              stop = await adapter.getStopById(dynEntry, id);
            }
          }
        }
    }
    // TransitLand fallback for any unresolved stop
    if (!stop) {
      stop = await transitland.getStop(id);
    }
  }

  if (stop) await cacheSet(key, stop, TTL.transit.stop);
  return stop;
}

// Stop Timetable (full-day schedule)

/**
 * Return all departures for a stop on a given date (YYYY-MM-DD).
 * Falls back to a full 24h departure window for providers that don't support date-based queries.
 */
export async function getStopTimetable(stopId: string, date: string): Promise<Departure[]> {
  const key = hashKey("transit:timetable", { stopId, date });
  const cached = await cacheGet<Departure[]>(key);
  if (cached) return cached;

  let departures: Departure[] = [];

  if (gtfsLocal.isGtfsLocalId(stopId)) {
    departures = await gtfsLocal.getTimetable(stopId, date);
  } else {
    // For real-time providers, fetch a full-day window (1440 min) starting at midnight of the date.
    // We query departures normally and filter to the requested date.
    const targetDate = new Date(`${date}T00:00:00`);
    const now = new Date();
    const minutesFromNow =
      targetDate > now ? Math.round((targetDate.getTime() - now.getTime()) / 60000) + 1440 : 1440;
    const allDeps = await getStopDepartures(stopId, Math.min(minutesFromNow, 10_080)); // cap at 7 days
    departures = allDeps.filter((d) => (d.scheduledAt ?? "").startsWith(date));
  }

  const ttl = date < new Date().toISOString().slice(0, 10) ? 86_400 : 300;
  await cacheSet(key, departures, ttl);
  return departures;
}

// Platform Stops (child stops of a parent station)

export async function getStopPlatforms(stopId: string): Promise<TransitStop[]> {
  const key = hashKey("transit:platforms", { stopId });
  const cached = await cacheGet<TransitStop[]>(key);
  if (cached) return cached;

  let platforms: TransitStop[] = [];

  if (gtfsLocal.isGtfsLocalId(stopId)) {
    platforms = await gtfsLocal.getPlatformStops(stopId);
  } else if (stopId.startsWith("db:")) {
    platforms = await dbVendo.getPlatformStops(stopId);
  }
  // Other providers don't expose platform-level child stops

  await cacheSet(key, platforms, TTL.transit.stops);
  return platforms;
}

// Departures

export async function getStopDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  const key = hashKey("transit:departures", { stopId, minutes });
  const cached = await cacheGet<Departure[]>(key);
  if (cached) return cached;

  let departures: Departure[] = [];

  if (gtfsLocal.isGtfsLocalId(stopId)) {
    departures = await gtfsLocal.getDepartures(stopId, minutes);
  } else {
    const regional = providerFromId(stopId);
    switch (regional) {
      case "tfl":
        departures = await tfl.getDepartures(stopId, minutes);
        break;
      case "irail":
        departures = await irail.getDepartures(stopId, minutes);
        break;
      case "mbta":
        departures = await mbta.getDepartures(stopId, minutes);
        break;
      case "opendata-ch":
        departures = await opendataCh.getDepartures(stopId, minutes);
        break;
      case "db":
        departures = await dbVendo.getDepartures(stopId, minutes);
        break;
      case "vbb":
      case "bvg": {
        const inst = hafasInstanceForProvider(regional);
        if (inst) departures = await hafas.getDepartures(inst, stopId, minutes);
        break;
      }
      default: {
        if (stopId.startsWith("mo:")) {
          departures = await transitous.getDepartures(stopId, minutes);
        } else if (stopId.startsWith("ms:")) {
          departures = await motisLocal.getDepartures(stopId, minutes);
        } else {
          // Try dynamic registry provider
          const dynEntry = dynamicEntryFromId(stopId);
          if (dynEntry) {
            const healthId = `dyn:${dynEntry.id}`;
            if (providerHealth.isHealthy(healthId)) {
              const adapter = getAdapter(dynEntry.protocol);
              if (adapter) {
                try {
                  departures = await adapter.getDepartures(dynEntry, stopId, minutes);
                  providerHealth.recordSuccess(healthId);
                } catch {
                  providerHealth.recordFailure(healthId);
                }
              }
            }
          } else {
            departures = await transitland.getDepartures(stopId, minutes);
          }
        }
      }
    }
  }

  await cacheSet(key, departures, TTL.transit.departures);
  return departures;
}

// Arrivals

export async function getStopArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  const key = hashKey("transit:arrivals", { stopId, minutes });
  const cached = await cacheGet<Departure[]>(key);
  if (cached) return cached;

  let arrivals: Departure[] = [];

  if (gtfsLocal.isGtfsLocalId(stopId)) {
    arrivals = await gtfsLocal.getArrivals(stopId, minutes);
  } else {
    const regional = providerFromId(stopId);
    switch (regional) {
      case "tfl":
        // TfL /Arrivals endpoint returns real-time arrival predictions — no separate arrivals API
        arrivals = await tfl.getDepartures(stopId, minutes);
        break;
      case "irail":
        arrivals = await irail.getArrivals(stopId, minutes);
        break;
      case "mbta":
        arrivals = await mbta.getDepartures(stopId, minutes);
        break;
      case "opendata-ch":
        arrivals = await opendataCh.getArrivals(stopId, minutes);
        break;
      case "db":
        arrivals = await dbVendo.getArrivals(stopId, minutes);
        break;
      case "vbb":
      case "bvg": {
        const inst = hafasInstanceForProvider(regional);
        if (inst) arrivals = await hafas.getArrivals(inst, stopId, minutes);
        break;
      }
      default: {
        if (stopId.startsWith("mo:")) {
          arrivals = await transitous.getArrivals(stopId, minutes);
        } else if (stopId.startsWith("ms:")) {
          arrivals = await motisLocal.getArrivals(stopId, minutes);
        } else {
          // Try dynamic registry provider
          const dynEntry = dynamicEntryFromId(stopId);
          if (dynEntry) {
            const healthId = `dyn:${dynEntry.id}`;
            if (providerHealth.isHealthy(healthId)) {
              const adapter = getAdapter(dynEntry.protocol);
              if (adapter) {
                try {
                  arrivals = await adapter.getArrivals(dynEntry, stopId, minutes);
                  providerHealth.recordSuccess(healthId);
                } catch {
                  providerHealth.recordFailure(healthId);
                }
              }
            }
          }
        }
        break;
      }
    }
  }

  await cacheSet(key, arrivals, TTL.transit.arrivals);
  return arrivals;
}

// Routes

export async function getRoutesInBbox(bbox: BBox): Promise<TransitRoute[]> {
  const key = hashKey("transit:routes_bbox", { bbox });
  const cached = await cacheGet<TransitRoute[]>(key);
  if (cached) return cached;

  const routes = await transitland.getRoutes({ bbox });
  await cacheSet(key, routes, TTL.transit.routes);
  return routes;
}

export async function getRoutesForStop(stopId: string): Promise<TransitRoute[]> {
  const key = hashKey("transit:routes_stop", { stopId });
  const cached = await cacheGet<TransitRoute[]>(key);
  if (cached) return cached;

  let routes: TransitRoute[] = [];

  if (stopId.startsWith("mo:")) {
    routes = await transitous.getRoutesForStop(stopId);
  } else if (stopId.startsWith("tl:")) {
    // TransitLand Onestop IDs — pass directly
    routes = await transitland.getRoutes({ stopId });
  } else {
    // All other providers (db, irail, opendata-ch, mbta, tfl, HAFAS instances, dynamic registry,
    // GTFS local, …): derive routes from a 12-hour departure window.
    //
    // Rationale: passing foreign stop IDs (e.g. "rsag:900012345") to TransitLand's
    // served_by_stops parameter causes TransitLand to ignore the unknown ID and return
    // its default first page of routes globally — completely unrelated routes from
    // agencies across Europe. Deriving from departures is always correct since every
    // provider already has a working getDepartures adapter.
    const departures = await getStopDepartures(stopId, 720);
    const seen = new Map<string, TransitRoute>();
    for (const dep of departures) {
      if (seen.has(dep.route.id)) continue;
      if (isTripNumber(dep.route.shortName)) continue;
      seen.set(dep.route.id, {
        id: dep.route.id,
        shortName: dep.route.shortName,
        longName: dep.route.longName,
        mode: dep.route.mode,
        color: dep.route.color,
        operatorName: "",
      });
    }
    routes = Array.from(seen.values());
  }

  await cacheSet(key, routes, TTL.transit.routes);

  // Also populate the individual route cache so getRoute(id) can find
  // routes that were derived from departures (db:, mo:, HAFAS, etc.)
  for (const route of routes) {
    const routeKey = hashKey("transit:route", { id: route.id });
    const existing = await cacheGet<TransitRoute>(routeKey);
    if (!existing) await cacheSet(routeKey, route, TTL.transit.routes);
  }

  return routes;
}

export async function getRoute(id: string): Promise<TransitRoute | null> {
  const key = hashKey("transit:route", { id });
  const cached = await cacheGet<TransitRoute>(key);
  if (cached) return cached;

  let route: TransitRoute | null = null;

  if (id.startsWith("mb:")) {
    route = await mbta.getRoute(id.slice(3));
  } else {
    // tfl: no simple route detail endpoint, fall through to transitland
    route = await transitland.getRoute(id);
  }

  if (!route) return null;

  // If the provider didn't return geometry, snap stop coordinates to roads
  if (!route.geometry) {
    const stops = await getRouteStops(id);
    if (stops.length >= 2) {
      const coords: [number, number][] = stops.map((s) => [s.lng, s.lat]);
      const matched = await matchToRoads(coords);
      if (matched) route.geometry = matched;
    }
  }

  await cacheSet(key, route, route.geometry ? TTL.transit.routeGeometry : TTL.transit.routes);
  return route;
}

export async function getRouteStops(routeId: string, hintStopId?: string): Promise<RouteStop[]> {
  // Include hintStopId in the cache key so a call without it doesn't poison the cache
  const key = hashKey("transit:route_stops", { routeId, hintStopId: hintStopId ?? null });
  const cached = await cacheGet<RouteStop[]>(key);
  if (cached) return cached;

  let stops: RouteStop[] = [];
  if (routeId.startsWith("mb:")) {
    stops = await mbta.getRouteStops(routeId.slice(3));
  } else if (routeId.startsWith("tfl:")) {
    stops = await tfl.getRouteStopSequence(routeId.slice(4));
  } else if (hintStopId) {
    // Derive stop sequence from a departure's trip detail.
    // Works for any provider that has getVehicleJourney support (db, mo, ir, HAFAS instances).
    const departures = await getStopDepartures(hintStopId, 720);
    const dep = departures.find((d) => d.route.id === routeId && d.tripId);
    if (dep?.tripId) {
      const journey = await getVehicleJourney(dep.tripId);
      if (journey) {
        stops = journey.stops.map((s, i) => ({
          id: s.stopId,
          name: s.name,
          lat: s.lat,
          lng: s.lng,
          platformCode: s.platform,
          sequence: i,
        }));
      }
    }
  }

  // Only cache non-empty results, or when we had a hintStopId (so the lookup was meaningful).
  // Don't cache empty results from calls without hintStopId — a retry with a hintStopId should work.
  if (stops.length > 0 || hintStopId) {
    await cacheSet(key, stops, TTL.transit.routeStops);
  }
  return stops;
}

// Alerts

export async function getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
  const key = hashKey("transit:alerts_bbox", { bbox });
  const cached = await cacheGet<ServiceAlert[]>(key);
  if (cached) return cached;

  const providers = getRegionalProviders(bbox);
  const tasks: Promise<ServiceAlert[]>[] = [];

  if (providers.includes("tfl")) tasks.push(tfl.getAlerts());
  if (providers.includes("mbta")) tasks.push(mbta.getAlerts());

  const results = await Promise.allSettled(tasks);
  const alerts: ServiceAlert[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") alerts.push(...result.value);
  }

  await cacheSet(key, alerts, TTL.transit.alerts);
  return alerts;
}

export async function getStopAlerts(stopId: string): Promise<ServiceAlert[]> {
  const key = hashKey("transit:stop_alerts", { stopId });
  const cached = await cacheGet<ServiceAlert[]>(key);
  if (cached) return cached;

  let alerts: ServiceAlert[] = [];
  const regional = providerFromId(stopId);

  if (regional === "mbta") {
    alerts = await mbta.getAlerts({ stopId: stopId.slice(3) });
  } else if (regional === "tfl") {
    alerts = await tfl.getStopAlerts(stopId);
  } else if (regional === "db") {
    alerts = await dbVendo.getStopAlerts(stopId);
  } else if (regional === "vbb" || regional === "bvg") {
    const inst = hafasInstanceForProvider(regional);
    if (inst) alerts = await hafas.getStopAlerts(inst, stopId);
  } else {
    // Dynamic registry: surface per-stop alerts (inline remarks via regional endpoint)
    const dynEntry = dynamicEntryFromId(stopId);
    if (dynEntry) {
      const adapter = getAdapter(dynEntry.protocol);
      if (adapter?.getAlerts) {
        const rawStopId = stopId.startsWith(dynEntry.prefix)
          ? stopId.slice(dynEntry.prefix.length)
          : stopId;
        alerts = await adapter.getAlerts(dynEntry, { stopId: rawStopId });
      }
    }
  }

  await cacheSet(key, alerts, TTL.transit.alerts);
  return alerts;
}

export async function getRouteAlerts(routeId: string): Promise<ServiceAlert[]> {
  const key = hashKey("transit:route_alerts", { routeId });
  const cached = await cacheGet<ServiceAlert[]>(key);
  if (cached) return cached;

  let alerts: ServiceAlert[] = [];
  if (routeId.startsWith("tfl:")) {
    alerts = await tfl.getRouteAlerts(routeId.slice(4));
  } else if (routeId.startsWith("mb:")) {
    alerts = await mbta.getAlerts({ routeId: routeId.slice(3) });
  } else {
    // Dynamic registry: fetch route-level alerts via the regional endpoint's remarks()
    const dynEntry = dynamicEntryFromId(routeId);
    if (dynEntry) {
      const adapter = getAdapter(dynEntry.protocol);
      if (adapter?.getAlerts) {
        const rawRouteId = routeId.startsWith(dynEntry.prefix)
          ? routeId.slice(dynEntry.prefix.length)
          : routeId;
        alerts = await adapter.getAlerts(dynEntry, { routeId: rawRouteId });
      }
    }
  }

  await cacheSet(key, alerts, TTL.transit.alerts);
  return alerts;
}

// Vehicles & Radar

export async function getVehiclePositions(routeId: string): Promise<VehiclePosition[]> {
  const key = hashKey("transit:vehicles", { routeId });
  const cached = await cacheGet<VehiclePosition[]>(key);
  if (cached) return cached;

  let vehicles: VehiclePosition[] = [];
  if (routeId.startsWith("mb:")) {
    vehicles = await mbta.getVehiclePositions(routeId.slice(3));
  }

  await cacheSet(key, vehicles, TTL.transit.vehicles);
  return vehicles;
}

export async function getVehicleRadar(bbox: BBox): Promise<VehiclePosition[]> {
  const key = hashKey("transit:radar", { bbox });
  const cached = await cacheGet<VehiclePosition[]>(key);
  if (cached) return cached;

  const tasks: Promise<VehiclePosition[]>[] = [];

  // Hardcoded HAFAS radar instances (VBB, BVG)
  const instances = hafas.getRadarInstances(bbox);
  for (const inst of instances) {
    tasks.push(hafas.getRadar(inst, bbox));
  }

  // Dynamic registry HAFAS entries that support radar
  const dynamicEntries = getDynamicProviders(bbox);
  for (const entry of dynamicEntries) {
    const adapter = getAdapter(entry.protocol);
    const healthId = `dyn:${entry.id}`;
    if (adapter?.getVehicleRadar && providerHealth.isHealthy(healthId)) {
      tasks.push(
        adapter.getVehicleRadar(entry, bbox).then(
          (v) => {
            providerHealth.recordSuccess(healthId);
            return v;
          },
          () => {
            providerHealth.recordFailure(healthId);
            return [] as VehiclePosition[];
          },
        ),
      );
    }
  }

  // Transitous global vehicle radar
  tasks.push(transitous.getVehicleRadar(bbox));

  const results = await Promise.allSettled(tasks);
  const vehicles: VehiclePosition[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") vehicles.push(...result.value);
  }

  await cacheSet(key, vehicles, TTL.transit.radar);
  return vehicles;
}

// Route Live (vehicles + alerts combined)

export async function getRouteLive(routeId: string): Promise<RouteLive> {
  const [vehicles, alerts] = await Promise.all([
    getVehiclePositions(routeId),
    getRouteAlerts(routeId),
  ]);
  return { vehicles, alerts };
}

// Vehicle Journeys (Trip Detail)

async function fetchJourneyForId(vehicleId: string): Promise<VehicleJourney | null> {
  try {
    if (vehicleId.startsWith("db:")) {
      return await dbVendo.getTrip(vehicleId);
    }
    if (vehicleId.startsWith("mo:")) {
      return await transitous.getTrip(vehicleId);
    }
    if (vehicleId.startsWith("ms:")) {
      // Self-hosted MOTIS uses the same trip API format as Transitous
      return await transitous.getTrip(vehicleId.replace(/^ms:/, "mo:"));
    }
    if (vehicleId.startsWith("ir:")) {
      return await irail.getVehicleJourney(vehicleId.slice(3));
    }
    // Try HAFAS instances (vbb:, bvg: prefixed trip IDs)
    const inst = hafas.instanceFromPrefix(vehicleId);
    if (inst) {
      return await hafas.getTrip(inst, vehicleId);
    }
    // Try dynamic registry provider (covers HAFAS instances like nrw:, rmv:, vsn:, etc.)
    const dynEntry = dynamicEntryFromId(vehicleId);
    if (dynEntry) {
      const adapter = getAdapter(dynEntry.protocol);
      if (adapter?.getTrip) {
        return await adapter.getTrip(dynEntry, vehicleId);
      }
    }
  } catch {
    // Provider failed
  }
  return null;
}

/**
 * Fetch a vehicle journey by trip ID.
 * Accepts a primary ID and optional fallback IDs (from merged departures).
 * Tries each in order until one succeeds.
 */
export async function getVehicleJourney(
  vehicleId: string,
  fallbackIds?: string[],
): Promise<VehicleJourney | null> {
  const key = hashKey("transit:vehicle_journey", { vehicleId });
  const cached = await cacheGet<VehicleJourney>(key);
  if (cached) return cached;

  let journey = await fetchJourneyForId(vehicleId);

  // Try fallback IDs if primary failed
  if (!journey && fallbackIds) {
    for (const id of fallbackIds) {
      if (id === vehicleId) continue;
      journey = await fetchJourneyForId(id);
      if (journey) break;
    }
  }

  if (journey) await cacheSet(key, journey, TTL.transit.vehicleJourney);
  return journey;
}

// Facilities

export async function getFacilities(stopId: string): Promise<Facility[]> {
  const key = hashKey("transit:facilities", { stopId });
  const cached = await cacheGet<Facility[]>(key);
  if (cached) return cached;

  let facilities: Facility[] = [];
  if (stopId.startsWith("mb:")) {
    facilities = await mbta.getFacilities(stopId.slice(3));
  }

  await cacheSet(key, facilities, TTL.transit.facilities);
  return facilities;
}

// Geometry Snapping

/** Set to true to enable Valhalla bus-profile road-snapping for bus legs. */
const ENABLE_BUS_LEG_SNAPPING = false;

/**
 * Snap bus leg geometries to the road network via Valhalla's bus profile.
 * Only applies to bus legs whose geometry is sparse relative to the number
 * of stops (i.e. just straight lines between stops, not road-snapped).
 * A road-snapped geometry typically has many more coordinates than stops.
 */
async function snapPlanGeometries(plan: TripPlan): Promise<void> {
  if (!ENABLE_BUS_LEG_SNAPPING) return;
  const tasks: Promise<void>[] = [];
  for (const itinerary of plan.itineraries) {
    for (const leg of itinerary.legs) {
      if (leg.mode !== "bus") continue;

      // Total stops on this leg = from + intermediates + to
      const stopCount = (leg._intermediateStopCount ?? 0) + 2;
      const coordCount = leg.geometry.coordinates.length;

      // If there are significantly more coordinates than stops,
      // the geometry is already road-snapped — skip.
      if (coordCount > stopCount * 3) continue;

      tasks.push(
        matchToRoads(leg.geometry.coordinates, "bus").then((result) => {
          if (result) leg.geometry = result;
        }),
      );
    }
  }
  await Promise.allSettled(tasks);
}

// Trip Planning

export async function planTrip(params: TripPlanParams): Promise<TripPlan | null> {
  const key = hashKey("transit:plan", params);
  const cached = await cacheGet<TripPlan>(key);
  if (cached) return cached;

  const plan = await otp.plan(params);
  if (plan) {
    plan.provider = "otp";
    await snapPlanGeometries(plan);
    await cacheSet(key, plan, TTL.transit.tripPlan);
    return plan;
  }

  // Regional fallbacks when OTP is unavailable
  const { fromLat, fromLng, toLat, toLng, date, time } = params;
  const tripBbox: BBox = [
    Math.min(fromLng, toLng),
    Math.min(fromLat, toLat),
    Math.max(fromLng, toLng),
    Math.max(fromLat, toLat),
  ];
  const providers = getRegionalProviders(tripBbox);

  let regionalPlan: TripPlan | null = null;

  const { arriveBy, numItineraries } = params;

  // Try VBB HAFAS journey planning (Berlin/Brandenburg)
  if (!regionalPlan && providers.includes("vbb")) {
    const inst = hafasInstanceForProvider("vbb");
    if (inst) {
      regionalPlan = await hafas.planJourney(
        inst,
        fromLat,
        fromLng,
        toLat,
        toLng,
        date,
        time,
        arriveBy,
        numItineraries,
      );
      if (regionalPlan) regionalPlan.provider = "vbb";
    }
  }

  // Try DB via db-vendo-client (covers all Germany)
  if (!regionalPlan && providers.includes("db")) {
    regionalPlan = await dbVendo.planJourney(
      fromLat,
      fromLng,
      toLat,
      toLng,
      date,
      time,
      arriveBy,
      numItineraries,
    );
    if (regionalPlan) regionalPlan.provider = "db";
  }

  if (!regionalPlan && providers.includes("irail")) {
    regionalPlan = await irail.planConnections(
      fromLat,
      fromLng,
      toLat,
      toLng,
      date,
      time,
      arriveBy,
      numItineraries,
    );
    if (regionalPlan) regionalPlan.provider = "irail";
  }
  if (!regionalPlan && providers.includes("opendata-ch")) {
    regionalPlan = await opendataCh.planConnections(
      fromLat,
      fromLng,
      toLat,
      toLng,
      date,
      time,
      arriveBy,
      numItineraries,
    );
    if (regionalPlan) regionalPlan.provider = "opendata-ch";
  }

  // Try dynamic registry providers
  if (!regionalPlan) {
    const dynamicEntries = getDynamicProviders(tripBbox);
    for (const entry of dynamicEntries) {
      const healthId = `dyn:${entry.id}`;
      if (!providerHealth.isHealthy(healthId)) continue;
      const adapter = getAdapter(entry.protocol);
      if (!adapter) continue;
      try {
        regionalPlan = await adapter.planJourney(
          entry,
          fromLat,
          fromLng,
          toLat,
          toLng,
          date,
          time,
          arriveBy,
          numItineraries,
        );
        providerHealth.recordSuccess(healthId);
      } catch {
        providerHealth.recordFailure(healthId);
      }
      if (regionalPlan) {
        regionalPlan.provider = `dyn:${entry.id}`;
        break;
      }
    }
  }

  // Transitous global fallback (MOTIS 2 — covers 117 regions with real-time data)
  if (!regionalPlan && providerHealth.isHealthy("transitous")) {
    try {
      regionalPlan = await transitous.planTrip(fromLat, fromLng, toLat, toLng, date, time);
      if (regionalPlan) regionalPlan.provider = "transitous";
      providerHealth.recordSuccess("transitous");
    } catch {
      providerHealth.recordFailure("transitous");
    }
  }

  if (regionalPlan) {
    await snapPlanGeometries(regionalPlan);
    await cacheSet(key, regionalPlan, TTL.transit.tripPlan);
  }
  return regionalPlan;
}

// Health Status

export function getProviderHealthStatus() {
  return providerHealth.getStatus();
}
