import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { initCache } from "@openmapx/mobility-core/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/mobility-core/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/mobility-core/nominatim";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { bielefeldClient } from "./providers/bielefeld-client.js";
import { cambioClient } from "./providers/cambio-client.js";
import { carSharingProvider } from "./providers/provider.js";
import { registerCarSharingClient } from "./providers/registry.js";
import { stadtteilAutoClient } from "./providers/stadtteilauto-client.js";
import { wuppertalClient } from "./providers/wuppertal-client.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  const motis = ctx.getRequiredService("motis");
  const nominatim = ctx.getRequiredService("nominatim");
  if (motis?.url) setSharedMobilityMotisUrl(motis.url);
  if (nominatim?.url) setSharedMobilityNominatimUrl(nominatim.url);

  registerCarSharingClient(cambioClient);
  registerCarSharingClient(stadtteilAutoClient);
  registerCarSharingClient(wuppertalClient);
  registerCarSharingClient(bielefeldClient);

  ctx.registerMobilityDataSource(carSharingProvider);
  registerPlaceResolver(carSharingProvider.id, createDataSourceResolver(carSharingProvider));
}
