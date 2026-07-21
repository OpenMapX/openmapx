import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { initCache } from "./cache.js";
import { declarePoiSources } from "./poi-sources.js";
import { setNoNobilApiKey } from "./providers/no-nobil.js";
import { setOcmApiKey } from "./providers/ocm.js";
import { evChargingProvider, setLogger, setManifestDataSources } from "./providers/provider.js";
import { setUsAfdcApiKey } from "./providers/us-afdc.js";
import { initRuntime } from "./runtime.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  initRuntime(ctx);
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setOcmApiKey(ctx.config.openChargeMapApiKey as string | undefined);
  setUsAfdcApiKey(ctx.config.afdcApiKey as string | undefined);
  setNoNobilApiKey(ctx.config.nobilApiKey as string | undefined);
  setLogger(ctx.log);
  setManifestDataSources(ctx.manifest.dataSources ?? []);
  ctx.registerPoiSources(declarePoiSources());
  ctx.registerMobilityDataSource(evChargingProvider);
  registerPlaceResolver(evChargingProvider.id, createDataSourceResolver(evChargingProvider));
}
