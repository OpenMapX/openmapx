import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { initCache } from "@openmapx/mobility-core/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/mobility-core/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/mobility-core/nominatim";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { setDbBikeCredentials } from "./providers/db-bike-client.js";
import {
  bikeSharingProvider,
  setDetailCache,
  setManifestDataSources,
} from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  setDetailCache(ctx.cache);
  setManifestDataSources(ctx.manifest.dataSources ?? []);
  const motis = ctx.getRequiredService("motis");
  const nominatim = ctx.getRequiredService("nominatim");
  if (motis?.url) setSharedMobilityMotisUrl(motis.url);
  if (nominatim?.url) setSharedMobilityNominatimUrl(nominatim.url);
  setDbBikeCredentials({
    clientId: ctx.config.dbClientId as string | undefined,
    apiKey: ctx.config.dbApiKey as string | undefined,
  });
  ctx.registerMobilityDataSource(bikeSharingProvider);
  registerPlaceResolver(bikeSharingProvider.id, createDataSourceResolver(bikeSharingProvider));
}
