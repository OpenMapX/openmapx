import { haversineKm } from "@openmapx/core";
import type { PlaceResolverContext } from "@openmapx/place-ids";
import { registerPlaceResolver } from "@openmapx/place-ids";
import type { IntegrationContext } from "./context";

/**
 * Shared shell for the coastal water-level / tide knowledge integrations
 * (IOC, Pegelonline, Kartverket/Norway, DFO IWLS/Canada). Every one of those
 * `integrations/knowledge-tides-*` index files repeats an identical skeleton:
 *
 *   - a `registerPlaceResolver(scheme, …)` that loads the catalog, finds a
 *     station by id, and emits a "Tide Station" place;
 *   - a `GET /tides` route that branches on `?station=` vs `?lat=&lng=`,
 *     short-circuits via a per-day `nearest:<lat>,<lng>:<day>` cache (with a
 *     `{ notFound: true }` sentinel + 204 responses), runs `findNearest`, calls
 *     the provider's `buildTidesResponse`, and sets a `Cache-Control` header.
 *
 * Only the genuinely provider-specific pieces are passed in via `config`:
 * the scheme, the catalog loader, the response builder, the station→place
 * mapping, the search radius, the sentinel TTL, the `Cache-Control` max-age,
 * and the 502 message. The cache-key buckets, datum/unit conversion, the
 * observation curve mappers and `TidesResponse` field assembly all live inside
 * each provider's `loadStations` / `buildTidesResponse`, so this factory never
 * touches them — guaranteeing byte-identical cache keys, TTLs and payloads.
 *
 * `haversineKm` and the `round4` coordinate-cache-key rounding are owned here
 * because they were byte-identical across all providers.
 *
 * The response type `R` is opaque to the factory; it only ever stores it in
 * the cache and forwards it to the client, so per-provider response shapes
 * (e.g. Canada's `currentLevel.quality` / `station.timezoneCorrHours`) pass
 * through untouched.
 */

/** A station record carrying at least coordinates — provider types extend this. */
export interface TideStationBase {
  lat: number;
  lng: number;
}

export interface TidesIntegrationConfig<S extends TideStationBase, R> {
  /** Place-id scheme this integration owns (e.g. "ioc", "pegel"). */
  readonly scheme: string;

  /** Load (and cache) the station catalog. Fully provider-specific. */
  loadStations(ctx: IntegrationContext): Promise<S[]>;

  /**
   * Resolve a place-resolver id (the part before the first `:`) to a station.
   * Mirrors each provider's `stations.find(...)` predicate (some match by
   * `code`, Canada matches `id || code`).
   */
  findStationById(stations: S[], id: string): S | undefined;

  /**
   * Resolve a `?station=` route param to a station. Defaults to
   * `findStationById` when omitted; provided separately only because the
   * route-param predicate and resolver predicate are independent today
   * (they happen to coincide per provider, but keeping them distinct avoids
   * silently coupling two call sites).
   */
  findStationByParam?(stations: S[], param: string): S | undefined;

  /** Build the place object for the resolver. Returns the host place type. */
  createPlace(station: S, resolveCtx: PlaceResolverContext): unknown;

  /** Build the tides response for a resolved station. Fully provider-specific. */
  buildTidesResponse(ctx: IntegrationContext, station: S, distanceKm: number): Promise<R | null>;

  /** Search radius for `findNearest` (km). */
  readonly maxStationDistanceKm: number;

  /**
   * TTL (seconds) for the `nearest:` cache entries and the `{ notFound: true }`
   * sentinel. This is each provider's `TIDES_TTL`.
   */
  readonly nearestCacheTtl: number;

  /** `Cache-Control: public, max-age=<this>` value for successful responses. */
  readonly cacheControlMaxAge: number;

  /** 502 body `{ message }` when a station resolves but has no data. */
  readonly unavailableMessage: string;

  /**
   * Optional hook run on a warm `nearest:` cache hit, BEFORE the response is
   * sent. Lets a provider mutate the cached payload (Canada re-fetches the
   * live `currentLevel` so warm hits don't pin a stale level for the full
   * TTL). Receives the cached response object; mutate in place and/or return.
   */
  onWarmNearestHit?(ctx: IntegrationContext, cached: R): Promise<void> | void;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function findNearest<S extends TideStationBase>(
  stations: S[],
  lat: number,
  lng: number,
  maxKm: number,
): { station: S; distanceKm: number } | null {
  let best: { station: S; distanceKm: number } | null = null;
  for (const s of stations) {
    const d = haversineKm(lat, lng, s.lat, s.lng);
    if (d <= maxKm && (!best || d < best.distanceKm)) best = { station: s, distanceKm: d };
  }
  return best;
}

/**
 * Wire a tide knowledge integration's place resolver + `/tides` route onto the
 * given context. Call once from the integration's `setup(ctx)`.
 */
export function createTidesIntegration<S extends TideStationBase, R>(
  ctx: IntegrationContext,
  config: TidesIntegrationConfig<S, R>,
): void {
  const findByParam =
    config.findStationByParam ??
    ((stations: S[], param: string) => config.findStationById(stations, param));

  registerPlaceResolver(config.scheme, async (value, resolveCtx) => {
    const id = value.split(":")[0].trim();
    if (!id) return null;
    const stations = await config.loadStations(ctx);
    const station = config.findStationById(stations, id);
    if (!station) return null;
    return config.createPlace(station, resolveCtx);
  });

  ctx.registerRoute("GET", "/tides", async (req, reply) => {
    const stationParam = req.query.station;
    let resolvedStation: S | null = null;
    let distanceKm = 0;

    if (stationParam) {
      const stations = await config.loadStations(ctx);
      const found = findByParam(stations, stationParam);
      if (!found) {
        reply.status(404).send({ message: "Unknown station" });
        return;
      }
      resolvedStation = found;
    } else {
      const lat = Number.parseFloat(req.query.lat ?? "");
      const lng = Number.parseFloat(req.query.lng ?? "");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        reply.status(400).send({ message: "Invalid coordinates" });
        return;
      }

      // Include the UTC date — events are bucketed today/tomorrow on the
      // client, so a cached response that spans midnight UTC would land
      // yesterday's events under today's label until the TTL expires.
      const dayKey = new Date().toISOString().slice(0, 10);
      const cacheKey = `nearest:${round4(lat)},${round4(lng)}:${dayKey}`;
      const cached = await ctx.cache.get<R | { notFound: true }>(cacheKey);
      if (cached) {
        if ("notFound" in (cached as object)) {
          reply.status(204).send(null);
          return;
        }
        if (config.onWarmNearestHit) {
          await config.onWarmNearestHit(ctx, cached as R);
        }
        reply.header("Cache-Control", `public, max-age=${config.cacheControlMaxAge}`);
        reply.send(cached);
        return;
      }

      const stations = await config.loadStations(ctx);
      const nearest = findNearest(stations, lat, lng, config.maxStationDistanceKm);
      if (!nearest) {
        await ctx.cache.set(cacheKey, { notFound: true } as const, config.nearestCacheTtl);
        reply.status(204).send(null);
        return;
      }
      resolvedStation = nearest.station;
      distanceKm = nearest.distanceKm;

      const result = await config.buildTidesResponse(ctx, resolvedStation, distanceKm);
      if (!result) {
        await ctx.cache.set(cacheKey, { notFound: true } as const, config.nearestCacheTtl);
        reply.status(204).send(null);
        return;
      }
      await ctx.cache.set(cacheKey, result, config.nearestCacheTtl);
      reply.header("Cache-Control", `public, max-age=${config.cacheControlMaxAge}`);
      reply.send(result);
      return;
    }

    const result = await config.buildTidesResponse(ctx, resolvedStation, distanceKm);
    if (!result) {
      reply.status(502).send({ message: config.unavailableMessage });
      return;
    }
    reply.header("Cache-Control", `public, max-age=${config.cacheControlMaxAge}`);
    reply.send(result);
  });
}
