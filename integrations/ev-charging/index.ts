import { type IntegrationContext, setOverpassUrl } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { createDataSourceResolver } from "../data-source/resolver.js";
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
  ctx.registerProvider("data-source", evChargingProvider);
  registerPlaceResolver(evChargingProvider.id, createDataSourceResolver(evChargingProvider));
}
