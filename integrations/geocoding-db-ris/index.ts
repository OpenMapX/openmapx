import type { Place } from "@openmapx/core";
import {
  createGeocoderSuggestionProvider,
  type IntegrationContext,
  type Wgs84BoundingBox,
} from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { dbRisGeocodingService, lookupDbStation, setRisCredentials } from "./provider.js";

const ATTRIBUTION_SOURCE_ID = "db-ris-stations";

/**
 * Germany plus the border stations RIS::Stations also lists (Basel, Salzburg,
 * Arnhem, ...). Suggestion fan-out skips the metered API for queries anchored
 * outside this box; the fallback-chain path is unaffected.
 */
const COVERAGE: Wgs84BoundingBox = [5.5, 45.5, 17.5, 55.5];

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => {
    setRisCredentials({
      clientId: ctx.config.clientId as string | undefined,
      apiKey: ctx.config.apiKey as string | undefined,
    });
  });
  ctx.registerGeocodingProvider(dbRisGeocodingService);
  ctx.registerSearchSuggestionProvider(
    createGeocoderSuggestionProvider({
      id: ctx.id,
      geocoder: dbRisGeocodingService,
      coverage: () => COVERAGE,
      attributions: () => [
        ctx.attributionIndex?.getById(ATTRIBUTION_SOURCE_ID) ?? {
          sourceId: ATTRIBUTION_SOURCE_ID,
          name: "Deutsche Bahn RIS Stations",
          url: "https://developers.deutschebahn.com/db-api-marketplace/apis/",
        },
      ],
    }),
  );

  // EVA primary-id dispatch: when a Place.id arrives as `eva:8000105`,
  // resolve it via the RIS station lookup. lookupDbStation returns a
  // Place extended with a station-specific `dataSourceDetail`; its own
  // return type is `Record<string, unknown>` to bypass the shape mismatch
  // between `StationDetail` and the generic `DataSourceDetail` type —
  // casting here keeps the resolver signature clean without widening the
  // core typing.
  registerPlaceResolver("eva", async (value, resolverCtx) => {
    if (!/^\d+$/.test(value)) return null;
    return (await lookupDbStation(value, resolverCtx.lang)) as unknown as Place;
  });
}
