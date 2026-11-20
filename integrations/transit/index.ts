import {
  normalizeSearchTerm,
  type SearchSuggestionProviderResult,
  type SearchSuggestionQuery,
} from "@openmapx/core";
import type {
  IntegrationContext,
  ProviderCallContext,
  SearchSuggestionProvider,
} from "@openmapx/integration-framework";
import {
  captureResultContributors,
  contributorsForRecords,
} from "@openmapx/mobility-core/contributors";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { getPlaceResolver } from "@openmapx/place-ids";
import { createTransitOrchestrator } from "./orchestrator.js";
import { createPlaceTransit } from "./place-transit.js";
import { createRefreshSession } from "./refresh-session.js";
import { createNetworkHandlers } from "./routes/network.js";
import { createPlaceHandlers } from "./routes/place.js";
import { createPlanHandlers } from "./routes/plan.js";
import { createReachabilityHandlers } from "./routes/reachability.js";
import { createStopHandlers } from "./routes/stops.js";

interface TransitSearchOrchestrator {
  searchByName(
    query: string,
    limit: number,
    context?: ProviderCallContext,
  ): Promise<MobilityResult<TransitStop[]>>;
}

export function createTransitSuggestionProvider(
  orchestrator: TransitSearchOrchestrator,
): SearchSuggestionProvider {
  return {
    id: "transit",
    async searchSuggestions(
      query: SearchSuggestionQuery,
      context,
    ): Promise<SearchSuggestionProviderResult> {
      const result = await orchestrator.searchByName(query.query, query.limit, context);
      const normalizedQuery = normalizeSearchTerm(query.query);
      return {
        suggestions: result.data.map((stop) => {
          const exactCode = stop.codes?.find(
            ({ value }) => normalizeSearchTerm(value) === normalizedQuery,
          );
          const matchedValue = exactCode?.value ?? stop.name;
          return {
            contributors: captureResultContributors(stop, result.attributions),
            id: stop.id,
            ids: stop.ids,
            label: stop.name,
            sublabel: exactCode ? exactCode.namespace.toUpperCase() : undefined,
            coordinates: [stop.lng, stop.lat],
            type: "transit_stop" as const,
            transitStop: stop,
            rawCategory: "public_transport/station",
            searchMatch: {
              kind: exactCode ? ("authoritative_code" as const) : ("name" as const),
              value: matchedValue,
              normalized: normalizeSearchTerm(matchedValue),
              namespace: exactCode?.namespace,
            },
            importance: 0.7,
            provider: "transit",
            contributingProviders: ["transit"],
          };
        }),
        attributions: contributorsForRecords(
          result.data.map((stop) => ({
            contributors: captureResultContributors(stop, result.attributions),
          })),
        ),
        freshnessSeconds: 300,
      };
    },
  };
}

/**
 * Registers the transit routes. Each registration stays a literal call here, so
 * the API surface can be read statically; the handlers live in `routes/` by domain.
 */
export function setup(ctx: IntegrationContext): void {
  const orchestrator = createTransitOrchestrator(ctx);
  ctx.registerSearchSuggestionProvider(createTransitSuggestionProvider(orchestrator));
  const placeTransit = createPlaceTransit(ctx, orchestrator, {
    // The OSM place resolver, which the geocoding integration registers with the
    // operator's Nominatim; without it, places link by their shown name.
    lookupLocalName: async (osmRef) => {
      const resolve = getPlaceResolver<{ localName?: string }>("osm");
      return resolve ? ((await resolve(osmRef, {}))?.localName ?? undefined) : undefined;
    },
  });
  const refreshSession = createRefreshSession(
    ctx,
    orchestrator,
    process.env.BETTER_AUTH_SECRET ?? "",
  );
  const stops = createStopHandlers(ctx, orchestrator);
  const network = createNetworkHandlers(ctx, orchestrator);
  const place = createPlaceHandlers(placeTransit);
  const plan = createPlanHandlers(orchestrator, refreshSession);
  const reachability = createReachabilityHandlers(ctx, orchestrator);

  ctx.registerRoute("GET", "/planning-capabilities", plan.capabilities);
  ctx.registerRoute("GET", "/stops", stops.inBbox);
  ctx.registerRoute("GET", "/stops/nearby", stops.nearby);
  ctx.registerRoute("GET", "/stops/search", stops.search);
  ctx.registerRoute("GET", "/stops/near-place", place.linkedStops);
  ctx.registerRoute("GET", "/stops/:id", stops.byId);
  ctx.registerRoute("GET", "/stops/:id/transfers", stops.transfers);
  ctx.registerRoute("GET", "/stops/:id/infrastructure", stops.infrastructure);
  ctx.registerRoute("GET", "/stops/:id/area", stops.area);
  ctx.registerRoute("GET", "/stops/:id/platform-stops", stops.platformStops);
  ctx.registerRoute("GET", "/stops/:id/timetable", stops.timetable);
  ctx.registerRoute("GET", "/stops/:id/departures", stops.departures);
  ctx.registerRoute("GET", "/stops/:id/arrivals", stops.arrivals);
  ctx.registerRoute("GET", "/stops/:id/alerts", stops.alerts);
  ctx.registerRoute("GET", "/stops/:id/facilities", stops.facilities);
  ctx.registerRoute("GET", "/routes", network.routes);
  ctx.registerRoute("GET", "/routes/for-place", place.routes);
  ctx.registerRoute("GET", "/routes/:id", network.route);
  ctx.registerRoute("GET", "/routes/:id/stops", network.routeStops);
  ctx.registerRoute("GET", "/routes/:id/alerts", network.routeAlerts);
  ctx.registerRoute("GET", "/routes/:id/live", network.routeLive);
  ctx.registerRoute("GET", "/leg-geometry", network.legGeometry);
  ctx.registerRoute("GET", "/plan", plan.plan, { rateLimitTier: "expensive" });
  ctx.registerRoute("POST", "/plan/resolve", plan.resolve);
  ctx.registerRoute("POST", "/plan/chain", plan.chain);
  ctx.registerRoute("POST", "/plan/refresh", plan.refresh);
  ctx.registerRoute("GET", "/reachability/capabilities", reachability.capabilities);
  ctx.registerRoute("POST", "/reachability/surface", reachability.surface, {
    rateLimitTier: "expensive",
  });
  ctx.registerRoute("POST", "/reachability/check", reachability.check, {
    rateLimitTier: "expensive",
  });
  ctx.registerRoute("POST", "/reachability/isochrone", reachability.isochrone, {
    rateLimitTier: "expensive",
  });
  ctx.registerRoute("GET", "/alerts", network.alerts);
  ctx.registerRoute("GET", "/vehicles", network.vehicles);
  ctx.registerRoute("GET", "/vehicles/:id", network.vehicleJourney);
  ctx.registerRoute("GET", "/departures/for-place", place.departures);
  ctx.registerRoute("GET", "/arrivals/for-place", place.arrivals);
  ctx.registerRoute("GET", "/alerts/for-place", place.alerts);
  ctx.registerRoute("GET", "/facilities/for-place", place.facilities);
}
