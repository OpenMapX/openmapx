import { createPlace, type Place } from "@openmapx/core";
import { type IntegrationContext, scalarQueries } from "@openmapx/integration-framework";
import {
  fetchHighLowPredictions,
  fetchLatestMet,
  fetchLatestWaterLevel,
  fetchTideCurve,
  findNearestStation,
  findStationById,
  loadStations,
  type MetReadings,
  type NoaaStation,
  type TideEvent,
  type WaterLevelReading,
} from "@openmapx/noaa-coops-data";
import { registerPlaceResolver } from "@openmapx/place-ids";

/**
 * Max straight-line distance to a NOAA tide-prediction station for which we
 * surface tides on a place panel. Tides only matter in very close proximity
 * to tidal water — a user a few km inland doesn't care that the nearest
 * station happens to be in a harbor over the horizon.
 *
 * NOAA stations sit on the water (piers, lighthouses, bridge crossings), so
 * "distance to station" approximates "distance to tidal water". 2 km is the
 * sweet spot: it keeps the row tight to waterfront features (beaches,
 * marinas, harbour-side restaurants, coastal hotels, parks on the shoreline)
 * while excluding inland locations even in dense coastal cities — e.g. in
 * Manhattan, the Financial District / Battery Park / South Street Seaport
 * still match, but Times Square (~1.9 km from the East 41st station) does not.
 */
const MAX_STATION_DISTANCE_KM = 2;
const PREDICTIONS_CACHE_TTL = 6 * 60 * 60; // 6 hours — predictions are deterministic
const OBSERVATION_CACHE_TTL = 5 * 60; // 5 minutes — matches NOAA's 6-min sampling

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function todayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
}

interface TidesResponse {
  station: {
    id: string;
    name: string;
    lat: number;
    lng: number;
    distanceKm: number;
    /** Hours offset from UTC for the station's standard time. */
    timezoneCorrHours?: number;
  };
  events: TideEvent[];
  /** 30-min sampled tide curve for the chart, same TZ as `events`. */
  curve: Array<{ time: string; valueFt: number }>;
  datum: "MLLW";
  units: "english";
  timeZone: "lst_ldt";
  /** Latest 6-min water-level observation, if the station publishes one. */
  currentLevel?: WaterLevelReading;
  /** Latest met readings, if the station publishes them. */
  met?: MetReadings;
}

/**
 * Read the 5-min water-level + met caches and refresh from upstream on miss.
 * Shared between the cold `buildTidesResponse` path and the warm coordinate-
 * cache hit path — without this, the 6-hour predictions cache would pin a
 * stale `currentLevel` / `met` for the full TTL whenever the live caches
 * expired between requests.
 */
async function refreshLiveReadings(
  stationId: string,
  log: Parameters<typeof fetchHighLowPredictions>[1],
  cache: IntegrationContext["cache"],
): Promise<{ currentLevel: WaterLevelReading | undefined; met: MetReadings | undefined }> {
  const livePromise = (async (): Promise<WaterLevelReading | undefined> => {
    const cached = await cache.get<WaterLevelReading | { notFound: true }>(`water:${stationId}`);
    if (cached) return "notFound" in cached ? undefined : cached;
    const fetched = await fetchLatestWaterLevel(stationId, log);
    void cache.set(
      `water:${stationId}`,
      fetched ?? { notFound: true as const },
      OBSERVATION_CACHE_TTL,
    );
    return fetched ?? undefined;
  })();

  const metPromise = (async (): Promise<MetReadings | undefined> => {
    const cached = await cache.get<MetReadings | { notFound: true }>(`met:${stationId}`);
    if (cached) return "notFound" in cached ? undefined : cached;
    const fetched = await fetchLatestMet(stationId, log);
    void cache.set(
      `met:${stationId}`,
      fetched ?? { notFound: true as const },
      OBSERVATION_CACHE_TTL,
    );
    return fetched ?? undefined;
  })();

  const [currentLevel, met] = await Promise.all([livePromise, metPromise]);
  return { currentLevel, met };
}

async function buildTidesResponse(
  station: NoaaStation,
  distanceKm: number,
  log: Parameters<typeof fetchHighLowPredictions>[1],
  cache: IntegrationContext["cache"],
): Promise<TidesResponse | null> {
  const events = await fetchHighLowPredictions(station.id, log);
  if (!events) return null;

  // Curve + live observations run in parallel; the latter is cached
  // separately because it has a shorter TTL.
  const curveCached = await cache.get<Array<{ time: string; valueFt: number }>>(
    `curve:${station.id}:${todayKey()}`,
  );
  const curvePromise: Promise<Array<{ time: string; valueFt: number }> | null> = curveCached
    ? Promise.resolve(curveCached)
    : fetchTideCurve(station.id, log).then((c) => {
        const compact = c?.map((e) => ({ time: e.time, valueFt: e.valueFt })) ?? [];
        if (compact.length) {
          void cache.set(`curve:${station.id}:${todayKey()}`, compact, PREDICTIONS_CACHE_TTL);
        }
        return compact;
      });

  const [curve, live] = await Promise.all([
    curvePromise,
    refreshLiveReadings(station.id, log, cache),
  ]);

  return {
    station: {
      id: station.id,
      name: station.name,
      lat: station.lat,
      lng: station.lng,
      distanceKm: Number(distanceKm.toFixed(2)),
      timezoneCorrHours: station.timezoneCorrHours,
    },
    events,
    curve: curve ?? [],
    datum: "MLLW",
    units: "english",
    timeZone: "lst_ldt",
    currentLevel: live.currentLevel,
    met: live.met,
  };
}

export function setup(ctx: IntegrationContext): void {
  // Resolver for `coops:` — when the overlay clicks a NOAA station marker,
  // we navigate to `coops:<stationId>`. The resolver returns a Place at the
  // station's coords; the PlaceTides widget (driven by lat/lng) then matches
  // that exact station via the nearest-station lookup.
  registerPlaceResolver("coops", async (value) => {
    const id = value.split(":")[0].trim();
    if (!id) return null;
    const stations = await loadStations(ctx.cache, ctx.log);
    const station = findStationById(stations, id);
    if (!station) return null;
    const place: Place = createPlace({
      primaryScheme: "coops",
      ids: { coops: station.id },
      name: station.name,
      address: station.state ?? "",
      countryCode: "us",
      coordinates: [station.lng, station.lat],
      category: "Tide Station",
      rawCategory: "marine/tide_station",
    });
    return place;
  });

  ctx.registerRoute("GET", "/tides", async (req, reply) => {
    const {
      lat,
      lng,
      station: stationParam,
    } = scalarQueries(req.query) as {
      lat?: string;
      lng?: string;
      station?: string;
    };

    // When a station ID is supplied (e.g. by the overlay), use it directly;
    // otherwise find the nearest tide-prediction station to the supplied coords.
    let resolvedStation: NoaaStation | null = null;
    let distanceKm = 0;
    if (stationParam) {
      const stations = await loadStations(ctx.cache, ctx.log);
      resolvedStation = findStationById(stations, stationParam);
      if (!resolvedStation) {
        reply.status(404).send({ message: "Unknown station" });
        return;
      }
    } else {
      const latNum = Number.parseFloat(lat ?? "");
      const lngNum = Number.parseFloat(lng ?? "");
      if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
        reply.status(400).send({ message: "Invalid coordinates" });
        return;
      }

      const cacheKey = `tides:${round4(latNum)},${round4(lngNum)}:${todayKey()}`;
      const cached = await ctx.cache.get<TidesResponse | { notFound: true }>(cacheKey);
      if (cached) {
        if ("notFound" in cached) {
          reply.status(204).send(null);
          return;
        }
        // `buildTidesResponse` is the canonical refresh point for the 5-min
        // `water:` and `met:` caches, but this coordinate fast path skips it.
        // Overlay the latest live readings before sending so warm hits don't
        // pin stale observations for the full PREDICTIONS_CACHE_TTL.
        const live = await refreshLiveReadings(cached.station.id, ctx.log, ctx.cache);
        cached.currentLevel = live.currentLevel;
        cached.met = live.met;
        reply.header("Cache-Control", "public, max-age=3600");
        reply.send(cached);
        return;
      }

      const stations = await loadStations(ctx.cache, ctx.log);
      if (stations.length === 0) {
        reply.status(502).send({ message: "Tide station catalog unavailable" });
        return;
      }
      const nearest = findNearestStation(
        stations,
        latNum,
        lngNum,
        MAX_STATION_DISTANCE_KM,
        "tide-predictions",
      );
      if (!nearest) {
        await ctx.cache.set(cacheKey, { notFound: true }, PREDICTIONS_CACHE_TTL);
        reply.status(204).send(null);
        return;
      }
      resolvedStation = nearest.station;
      distanceKm = nearest.distanceKm;
    }

    const result = await buildTidesResponse(resolvedStation, distanceKm, ctx.log, ctx.cache);
    if (!result) {
      reply.status(502).send({ message: "Tide predictions unavailable" });
      return;
    }

    // Cache the by-coords response too so the next user at the same place
    // hits a fast Redis path.
    if (!stationParam && lat && lng) {
      const latNum = Number.parseFloat(lat);
      const lngNum = Number.parseFloat(lng);
      const cacheKey = `tides:${round4(latNum)},${round4(lngNum)}:${todayKey()}`;
      await ctx.cache.set(cacheKey, result, PREDICTIONS_CACHE_TTL);
    }

    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(result);
  });
}
