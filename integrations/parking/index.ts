import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { setBahnParkCredentials } from "./providers/db-bahnpark.js";
import { setNswTransportApiKey } from "./providers/nsw-au.js";
import { parkingProvider } from "./providers/provider.js";
import { setUtmcCredentials } from "./providers/utmc-newcastle.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setBahnParkCredentials({
    clientId: ctx.config.clientId as string | undefined,
    apiKey: ctx.config.apiKey as string | undefined,
  });
  setUtmcCredentials({
    username: ctx.config.utmcUsername as string | undefined,
    password: ctx.config.utmcPassword as string | undefined,
  });
  setNswTransportApiKey(ctx.config.nswTransportApiKey as string | undefined);
  ctx.registerMobilityDataSource(parkingProvider);
  registerPlaceResolver(parkingProvider.id, createDataSourceResolver(parkingProvider));
}
