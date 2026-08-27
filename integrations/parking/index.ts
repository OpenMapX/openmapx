import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { declarePoiSources } from "./poi-sources.js";
import { parkingProvider, setLogger, setManifestDataSources } from "./providers/provider.js";
import { initRuntime, stageRuntimeCommit } from "./runtime.js";

export function setup(ctx: IntegrationContext): void {
  initRuntime(ctx);
  const resolved = ctx.getRequiredService("overpass");
  stageRuntimeCommit(() => {
    if (resolved?.url) setOverpassUrl(resolved.url);
    setManifestDataSources(ctx.manifest.dataSources ?? []);
    setLogger(ctx.log);
  });
  ctx.registerPoiSources(declarePoiSources());
  ctx.registerMobilityDataSource(parkingProvider);
  registerPlaceResolver(parkingProvider.id, createDataSourceResolver(parkingProvider));
}
