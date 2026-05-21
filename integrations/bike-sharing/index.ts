import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { initCache } from "@openmapx/shared-mobility/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/shared-mobility/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/shared-mobility/nominatim";
import { setDbBikeCredentials } from "./providers/db-bike-client.js";
import { bikeSharingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  const motis = ctx.getRequiredService("motis");
  const nominatim = ctx.getRequiredService("nominatim");
  if (motis?.url) setSharedMobilityMotisUrl(motis.url);
  if (nominatim?.url) setSharedMobilityNominatimUrl(nominatim.url);
  setDbBikeCredentials({
    clientId: ctx.config.clientId as string | undefined,
    apiKey: ctx.config.apiKey as string | undefined,
  });
  ctx.registerProvider("data-source", bikeSharingProvider);
  registerPlaceResolver(bikeSharingProvider.id, createDataSourceResolver(bikeSharingProvider));
}
