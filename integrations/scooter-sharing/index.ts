import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { initCache } from "@openmapx/integration-shared-mobility/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/integration-shared-mobility/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/integration-shared-mobility/nominatim";
import { createDataSourceResolver } from "../data-source/resolver.js";
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
