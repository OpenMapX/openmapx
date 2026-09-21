import {
  createGeocoderSuggestionProvider,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import type { PlaceResolverContext } from "@openmapx/place-ids";
import { registerPlaceResolver } from "@openmapx/place-ids";
import {
  enturGeocodingService,
  getEnturCoverage,
  lookupEnturPlaceById,
  setEnturGeocodingConfig,
} from "./provider.js";

const ATTRIBUTION_SOURCE_ID = "entur-geocoder";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => {
    setEnturGeocodingConfig({
      endpoint: ctx.config.endpoint as string | undefined,
      clientName: ctx.config.clientName as string | undefined,
      boundaryCountry: ctx.config.boundaryCountry as string | undefined,
      multiModal: ctx.config.multiModal as "parent" | "child" | "all" | undefined,
    });
  });

  ctx.registerGeocodingProvider(enturGeocodingService);
  // Also feed the ranked suggestion fan-out, so Norwegian stop places and
  // addresses surface next to the general geocoder's results instead of only
  // when every provider ahead of Entur in the fallback chain came back empty.
  ctx.registerSearchSuggestionProvider(
    createGeocoderSuggestionProvider({
      id: ctx.id,
      geocoder: enturGeocodingService,
      coverage: getEnturCoverage,
      attributions: () => [
        ctx.attributionIndex?.getById(ATTRIBUTION_SOURCE_ID) ?? {
          sourceId: ATTRIBUTION_SOURCE_ID,
          name: "Entur Geocoder API",
          url: "https://developer.entur.org/pages-geocoder-intro/",
          attributionText: "Data made available by Entur",
        },
      ],
    }),
  );

  registerPlaceResolver("entur", async (value: string, resolverCtx: PlaceResolverContext) =>
    lookupEnturPlaceById(value, resolverCtx.lang),
  );
  registerPlaceResolver("nsr", async (value: string, resolverCtx: PlaceResolverContext) =>
    lookupEnturPlaceById(`NSR:${value}`, resolverCtx.lang),
  );
}
