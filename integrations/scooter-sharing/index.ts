import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { initCache } from "@openmapx/shared-mobility/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/shared-mobility/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/shared-mobility/nominatim";
import { setNrwMobidromCredentials } from "./providers/nrw-mobidrom-client.js";
import { scooterSharingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  const motis = ctx.getRequiredService("motis");
  const nominatim = ctx.getRequiredService("nominatim");
  if (motis?.url) setSharedMobilityMotisUrl(motis.url);
  if (nominatim?.url) setSharedMobilityNominatimUrl(nominatim.url);
  setNrwMobidromCredentials({
    clientId: ctx.config.nrwMobidromClientId as string | undefined,
    clientSecret: ctx.config.nrwMobidromClientSecret as string | undefined,
  });
  ctx.registerProvider("data-source", scooterSharingProvider);
  registerPlaceResolver(
    scooterSharingProvider.id,
    createDataSourceResolver(scooterSharingProvider),
  );
}
