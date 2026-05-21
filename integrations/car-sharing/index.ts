import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { initCache } from "@openmapx/shared-mobility/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/shared-mobility/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/shared-mobility/nominatim";
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

  ctx.registerProvider("data-source", carSharingProvider);
  registerPlaceResolver(carSharingProvider.id, createDataSourceResolver(carSharingProvider));
}
