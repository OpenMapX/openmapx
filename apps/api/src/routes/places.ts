import { lookupByCoords, lookupByNameAndCoords } from "@integrations/geocoding/place-lookup";
import { disallowedPhotoIntegrationIds } from "@integrations/photos/orchestrator";
import {
  buildPlaceDetailsRequest,
  type CategoryCardEnrichmentResponse,
  categoryPlaceToPlace,
  isDisplayablePhoto,
  openingHoursSourceFromOsm,
  type Place,
  parseId,
} from "@openmapx/core";
import { ambientPlaceToCategoryPlace } from "@openmapx/core/ambient-places";
import { readAmbientPlaceByGers } from "@openmapx/core/ambient-places-server";
import { currentOpeningHoursInfo } from "@openmapx/core/server";
import { getPlaceResolver, type PlaceResolverContext } from "@openmapx/place-ids";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "../db/index.js";
import { isEnabledIntegrationScheme } from "../integration-host.js";
import {
  CARD_DEADLINE_MS,
  type CardRequest,
  enrichCard,
  normalizeCardRequest,
} from "../services/place-details/card-cache.js";
import {
  enrichPlace,
  PLACE_DETAIL_DEADLINE_MS,
  photoProviderHost,
  placeEnrichQueue,
} from "../services/place-details/enrichment.js";
import { isWorkAdmissionError, type WorkAdmissionError } from "../utils/bounded-work-queue.js";
import { cacheGet, hashKey, TTL, withCache } from "../utils/cache.js";
import { requestNetworkKey } from "../utils/rate-limit.js";
import { bindRequestAbort, withDeadline } from "../utils/request-abort.js";
import { declareRouteAuth } from "../utils/route-auth.js";

interface PlaceByIdQuery {
  lat?: string;
  lng?: string;
  name?: string;
  lang?: string;
  hasAddress?: string;
}

interface CacheableError {
  statusCode: number;
  message: string;
}

function isDeadlineReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "TimeoutError";
}

function admissionStatus(error: WorkAdmissionError): number {
  return error.reason === "client-capacity" ? 429 : 503;
}

export const placesRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  fastify.post<{ Body: unknown }>("/places/card-enrichment", {
    bodyLimit: 128 * 1024,
    handler: async (req, reply) => {
      const body = normalizeCardRequest(req.body);
      if (!body) return reply.status(400).send({ error: "Invalid card enrichment request" });
      const disconnect = bindRequestAbort(req, reply);
      try {
        const request: CardRequest = {
          client: requestNetworkKey(req),
          deadlineAt: Date.now() + CARD_DEADLINE_MS,
          signal: disconnect.signal,
        };
        const results = await Promise.all(
          body.places.map((place) => enrichCard(place, body.lang, request)),
        );
        return { results } satisfies CategoryCardEnrichmentResponse;
      } finally {
        disconnect.dispose();
      }
    },
  });

  fastify.get<{
    Params: { id: string };
    Querystring: PlaceByIdQuery;
  }>("/places/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      querystring: {
        type: "object",
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
          lang: { type: "string" },
          hasAddress: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const rawId = req.params.id;
      const lang = req.query.lang;
      const hasAddress = req.query.hasAddress === "1";
      const latInput = Number.parseFloat(req.query.lat ?? "");
      const lngInput = Number.parseFloat(req.query.lng ?? "");
      const placeRequest = buildPlaceDetailsRequest({
        id: rawId,
        coordinates:
          Number.isFinite(latInput) && Number.isFinite(lngInput) ? [lngInput, latInput] : undefined,
        name: req.query.name,
        lang,
        hasAddress,
      });
      // The shared canonical identity contains every normalized input that can
      // affect resolution or enrichment. Hash the structured value so
      // unconstrained string fields cannot create separator collisions.
      const disconnect = bindRequestAbort(req, reply);
      const waiting = withDeadline(disconnect.signal, PLACE_DETAIL_DEADLINE_MS);
      try {
        const parsed = parseId(rawId);
        const published =
          parsed?.scheme === "overture" && !getPlaceResolver("overture")
            ? await readAmbientPlaceByGers(sql, parsed.value)
            : null;
        // The enriched place holds hero photos, so a photo integration the
        // policy now disallows must not be replayed from the cached place.
        const disallowedPhotoIntegrations = await disallowedPhotoIntegrationIds(photoProviderHost);
        const cacheKey = hashKey(
          "cache:place-v4-photo-metadata",
          published
            ? {
                ...placeRequest.identity,
                ambientGeneration: published.generation,
                disallowedPhotoIntegrations,
              }
            : { ...placeRequest.identity, disallowedPhotoIntegrations },
        );
        const resolveAndEnrich = (signal: AbortSignal) =>
          withCache(cacheKey, TTL.places.detail, async () => {
            const parsedId = parseId(rawId);
            const latQ = placeRequest.identity.lat ?? Number.NaN;
            const lngQ = placeRequest.identity.lng ?? Number.NaN;
            const resolverCtx: PlaceResolverContext = {
              lang: placeRequest.identity.lang ?? undefined,
              lat: Number.isFinite(latQ) ? latQ : undefined,
              lng: Number.isFinite(lngQ) ? lngQ : undefined,
              hasAddress,
            };

            // Registered resolver dispatch — each scheme's owner integration
            // registers a resolver at boot (see `integrations/geocoding`,
            // `integrations/geocoding-db-ris`, and the per-provider data-source
            // resolvers registered via `createDataSourceResolver`).
            if (parsedId) {
              const resolver = getPlaceResolver<Place>(parsedId.scheme);
              if (resolver) {
                const resolved = await resolver(parsedId.value, resolverCtx);
                if (!resolved) {
                  const err: CacheableError = {
                    statusCode: 404,
                    message: `No match for ${rawId}`,
                  };
                  throw err;
                }
                return enrichPlace(resolved, placeRequest.identity.lang ?? undefined, signal);
              }
              // The optional search provider may be disabled. An ambient
              // publication still owns its GERS identity; never snap that record
              // to a neighboring OSM object through coordinate fallback.
              if (published) {
                return enrichPlace(
                  categoryPlaceToPlace(
                    ambientPlaceToCategoryPlace(
                      published.place,
                      placeRequest.identity.lang ?? "en",
                    ),
                  ),
                  placeRequest.identity.lang ?? undefined,
                  signal,
                );
              }
              // No resolver registered for this scheme. The coord-fallback
              // below would happily snap to the nearest OSM POI — fine for
              // freeform UI schemes (saved labels, basemap POI clicks,
              // street-level imagery drops) that aren't backed by any integration,
              // dangerous for an integration whose `setup()` failed and
              // never got to register its resolver. The manifest registry
              // tells us which is which: enabled integration schemes are strict.
              // OSM references also remain exact when their owning integration
              // is unavailable; coordinates cannot establish another object's identity.
              if (parsedId.scheme === "osm" || isEnabledIntegrationScheme(parsedId.scheme)) {
                fastify.log.warn(
                  { scheme: parsedId.scheme },
                  "places: integration scheme has no resolver; refusing coord-fallback",
                );
                const err: CacheableError = {
                  statusCode: 404,
                  message: `No resolver for scheme '${parsedId.scheme}'`,
                };
                throw err;
              }
            }

            // Coord-fallback path for schemes without a registered resolver
            // (saved-label handles, coordinate fallbacks, opaque deep-link
            // ids). Requires lat/lng/name — without them there's nothing to do.
            const lat = latQ;
            const lng = lngQ;
            const name = placeRequest.identity.name ?? "";

            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
              const err: CacheableError = {
                statusCode: 400,
                message: "Non-resolvable place ID requires lat and lng query parameters",
              };
              throw err;
            }

            if (!name) {
              const err: CacheableError = {
                statusCode: 400,
                message: "Non-resolvable place ID requires lat, lng, and name query parameters",
              };
              throw err;
            }

            const place =
              (await lookupByNameAndCoords(
                name,
                lat,
                lng,
                rawId,
                placeRequest.identity.lang ?? undefined,
              )) ??
              (await lookupByCoords(lat, lng, rawId, placeRequest.identity.lang ?? undefined));

            if (!place) {
              const err: CacheableError = {
                statusCode: 404,
                message: `No OSM match found near [${lat}, ${lng}]`,
              };
              throw err;
            }

            return enrichPlace(place, placeRequest.identity.lang ?? undefined, signal);
          });
        // Cached details never enter the queue. A miss is admitted against the
        // global and per-network budget, and equal requests share one execution.
        const result =
          (await cacheGet<Place>(cacheKey)) ??
          (await placeEnrichQueue.run(
            {
              key: cacheKey,
              client: requestNetworkKey(req),
              deadlineAt: Date.now() + PLACE_DETAIL_DEADLINE_MS,
              signal: waiting,
            },
            resolveAndEnrich,
          ));
        const openingHoursInfo = await currentOpeningHoursInfo(result.openingHours, {
          lat: result.coordinates[1],
          lon: result.coordinates[0],
          countryCode: result.countryCode,
        });
        reply.header("Cache-Control", "no-store");
        const openingHoursSource = result.openingHours
          ? (result.openingHoursSource ?? openingHoursSourceFromOsm(result.id, result.osmTags))
          : undefined;
        const current = { ...result, openingHoursInfo, openingHoursSource };
        return current.photos
          ? { ...current, photos: current.photos.filter(isDisplayablePhoto) }
          : current;
      } catch (err) {
        if (isWorkAdmissionError(err)) {
          return reply
            .header("Retry-After", String(Math.ceil(err.retryAfterMs / 1000)))
            .status(admissionStatus(err))
            .send({ error: err.message });
        }
        if (waiting.aborted) {
          // Either the shared deadline passed or the client is gone; neither is a server fault.
          return isDeadlineReason(waiting.reason)
            ? reply.status(504).send({ error: "Place details took too long" })
            : reply.status(503).send({ error: "Request cancelled" });
        }
        const e = err as CacheableError;
        const statusCode = e.statusCode ?? 500;
        return reply
          .status(statusCode)
          .send({ error: statusCode >= 500 ? "Internal server error" : e.message });
      } finally {
        disconnect.dispose();
      }
    },
  });
};
