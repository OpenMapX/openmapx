import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { initCache } from "@openmapx/mobility-core/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/mobility-core/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/mobility-core/nominatim";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { setNrwMobidromCredentials } from "./providers/nrw-mobidrom-client.js";
import {
  scooterSharingProvider,
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
  setNrwMobidromCredentials({
    clientId: ctx.config.nrwMobidromClientId as string | undefined,
    clientSecret: ctx.config.nrwMobidromClientSecret as string | undefined,
  });
  ctx.registerMobilityDataSource(scooterSharingProvider);
  registerPlaceResolver(
    scooterSharingProvider.id,
    createDataSourceResolver(scooterSharingProvider),
  );
}
