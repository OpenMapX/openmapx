import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { setDeTankerkoenigApiKey, setFuelLogger } from "./providers/factory.js";
import { fuelProvider, setManifestDataSources } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  // Source attribution metadata from the manifest so every credit shown in
  // the UI is traceable to a single declaration site. Must run before
  // `registerMobilityDataSource` so the provider's `attribution` field has
  // its data when the framework reads it.
  ctx.onActivate(() => {
    if (resolved?.url) setOverpassUrl(resolved.url);
    setFuelLogger(ctx.log);
    setDeTankerkoenigApiKey(ctx.config["de-tankerkoenig-api-key"] as string | undefined);
    setManifestDataSources(ctx.manifest.dataSources ?? []);
  });
  ctx.registerMobilityDataSource(fuelProvider);
  registerPlaceResolver(fuelProvider.id, createDataSourceResolver(fuelProvider));
}
