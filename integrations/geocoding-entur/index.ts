import type { IntegrationContext } from "@openmapx/core";
import type { PlaceResolverContext } from "@openmapx/core/server";
import { registerPlaceResolver } from "@openmapx/core/server";
import {
  enturGeocodingService,
  lookupEnturPlaceById,
  setEnturGeocodingConfig,
} from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  setEnturGeocodingConfig({
    endpoint: ctx.config.endpoint as string | undefined,
    clientName: ctx.config.clientName as string | undefined,
    boundaryCountry: ctx.config.boundaryCountry as string | undefined,
    multiModal: ctx.config.multiModal as "parent" | "child" | "all" | undefined,
  });

  ctx.registerProvider("geocoding", enturGeocodingService);

  registerPlaceResolver("entur", async (value: string, resolverCtx: PlaceResolverContext) =>
    lookupEnturPlaceById(value, resolverCtx.lang),
  );
  registerPlaceResolver("nsr", async (value: string, resolverCtx: PlaceResolverContext) =>
    lookupEnturPlaceById(`NSR:${value}`, resolverCtx.lang),
  );
}
