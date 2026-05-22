import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { initCache } from "./cache.js";
import { setAfdcApiKey } from "./providers/afdc.js";
import { setNobilApiKey } from "./providers/nobil.js";
import { setOcmApiKey } from "./providers/ocm.js";
import { evChargingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setOcmApiKey(ctx.config.apiKey as string | undefined);
  setAfdcApiKey(ctx.config.afdcApiKey as string | undefined);
  setNobilApiKey(ctx.config.nobilApiKey as string | undefined);
  ctx.registerMobilityDataSource(evChargingProvider);
  registerPlaceResolver(evChargingProvider.id, createDataSourceResolver(evChargingProvider));
}
