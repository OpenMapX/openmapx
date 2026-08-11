import type { FastifyInstance } from "fastify";
import { adminRoute } from "./admin";
import { adminCacheRoute } from "./admin-cache";
import { registerCapabilityBindingRoutes } from "./admin-capability-bindings";
import { registerAdminComposeRoutes } from "./admin-compose";
import { adminDawarichRoute } from "./admin-dawarich";
import { adminExtensionsRoute } from "./admin-extensions";
import { adminServicesRoute } from "./admin-services";
import { adminSettingsRoute } from "./admin-settings";
import { adminSystemRoute } from "./admin-system";
import { attributionRoute } from "./attribution";
import { authRoute } from "./auth";
import { capabilitiesRoute } from "./capabilities";
import { dataManagerRoute } from "./data-manager";
import { elevationRoute } from "./elevation";
import { imageProxyRoute } from "./image-proxy";
import { internalMetricsRoute } from "./internal-metrics";
import { internalPoiSourcesRoute } from "./internal-poi-sources";
import { isochroneRoute } from "./isochrone";
import { legalConfigRoute } from "./legal-config";
import { maptilerRoute } from "./maptiler";
import { meRoute } from "./me";
import { metaRoute } from "./meta";
import { mobileAuthRoute } from "./mobile-auth";
import { neighborhoodsRoute } from "./neighborhoods";
import { offlinePackagesRoute } from "./offline-packages";
import { osmContributionsRoute } from "./osm-contributions";
import { placesRoute } from "./places";
import { reviewsKeypairRoute } from "./reviews-keypair";
import { savedRoute } from "./saved";
import { statusRoute } from "./status";
import { streetLevelRoute } from "./street-level-imagery";
import { tilesRoute } from "./tiles";
import { timelineRoute } from "./timeline";
import { trafficRoute } from "./traffic";
import { winterSportsRoute } from "./winter-sports";

export interface CoreRouteOptions {
  /** Better Auth's Fetch-API handler, bridged by `authRoute`. */
  authHandler: (request: Request) => Promise<Response>;
  /** Origin the auth interaction pages redirect to. */
  authUiOrigin: string;
}

/**
 * Registers every route the API serves that is not contributed by an
 * integration. This is the single source of truth for the core HTTP surface:
 * `server.ts` mounts it on the real server, and the OpenAPI generator mounts it
 * on a bare Fastify instance with no database, cache, or integration host.
 *
 * Registering a core route anywhere else makes it invisible to the generated
 * `openapi.json` and therefore to the surface gate — add it here instead.
 */
export async function registerCoreRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  server: FastifyInstance<any, any, any, any>,
  options: CoreRouteOptions,
): Promise<void> {
  await server.register(authRoute, options);

  await server.register(metaRoute);

  await server.register(capabilitiesRoute, { prefix: "/api" });
  await server.register(legalConfigRoute, { prefix: "/api" });
  await server.register(mobileAuthRoute, { prefix: "/api" });

  await server.register(placesRoute, { prefix: "/api" });
  await server.register(neighborhoodsRoute, { prefix: "/api" });
  await server.register(offlinePackagesRoute, { prefix: "/api" });

  await server.register(elevationRoute, { prefix: "/api" });
  await server.register(trafficRoute, { prefix: "/api" });
  await server.register(tilesRoute, { prefix: "/api" });
  await server.register(streetLevelRoute, { prefix: "/api" });
  await server.register(maptilerRoute, { prefix: "/api" });
  await server.register(isochroneRoute, { prefix: "/api" });
  await server.register(imageProxyRoute, { prefix: "/api" });
  await server.register(internalMetricsRoute, { prefix: "/api" });
  await server.register(internalPoiSourcesRoute, { prefix: "/api" });
  await server.register(winterSportsRoute, { prefix: "/api" });
  await server.register(reviewsKeypairRoute, { prefix: "/api" });
  await server.register(savedRoute, { prefix: "/api" });
  await server.register(osmContributionsRoute(), { prefix: "/api" });
  await server.register(timelineRoute, { prefix: "/api" });
  await server.register(meRoute, { prefix: "/api" });
  await server.register(statusRoute, { prefix: "/api" });
  await server.register(adminRoute, { prefix: "/api" });
  await server.register(adminServicesRoute, { prefix: "/api" });
  await server.register(adminDawarichRoute, { prefix: "/api" });
  await server.register(dataManagerRoute, { prefix: "/api" });
  await server.register(adminSettingsRoute, { prefix: "/api" });
  await server.register(adminExtensionsRoute, { prefix: "/api" });
  await server.register(adminCacheRoute, { prefix: "/api" });
  await server.register(adminSystemRoute, { prefix: "/api" });
  await server.register(attributionRoute, { prefix: "/api" });

  await registerCapabilityBindingRoutes(server);
  await registerAdminComposeRoutes(server);
}
