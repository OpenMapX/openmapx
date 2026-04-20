import { type IntegrationContext, setOverpassUrl } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { createDataSourceResolver } from "../data-source/resolver.js";
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
  ctx.registerProvider("data-source", parkingProvider);
  registerPlaceResolver(parkingProvider.id, createDataSourceResolver(parkingProvider));
}
