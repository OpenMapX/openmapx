import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { initCache } from "./cache.js";
import { setDotLogger } from "./providers/dot/index.js";
import { setNpsApiKey } from "./providers/nps.js";
import { setManifestDataSources, webcamProvider } from "./providers/provider.js";
import { setWindyApiKey } from "./providers/windy.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setDotLogger(ctx.log);
  setWindyApiKey(ctx.config.windyApiKey as string | undefined);
  setNpsApiKey(ctx.config.npsApiKey as string | undefined);
  setManifestDataSources(ctx.manifest.dataSources ?? []);
  ctx.registerMobilityDataSource(webcamProvider);
  registerPlaceResolver(webcamProvider.id, createDataSourceResolver(webcamProvider));
}
