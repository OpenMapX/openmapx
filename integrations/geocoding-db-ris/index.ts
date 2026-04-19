import type { IntegrationContext, Place } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { dbRisGeocodingService, lookupDbStation } from "./provider.js";
import { setRisCredentials } from "./ris-client.js";

export function setup(ctx: IntegrationContext): void {
  setRisCredentials({
    clientId: ctx.config.clientId as string | undefined,
    apiKey: ctx.config.apiKey as string | undefined,
  });
  ctx.registerProvider("geocoding", dbRisGeocodingService);

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
