import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { setTankerkoenigApiKey } from "./providers/factory.js";
import { fuelProvider, setManifestDataSources } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setTankerkoenigApiKey(ctx.config.apiKey as string | undefined);
  // Source attribution metadata from the manifest so every credit shown in
  // the UI is traceable to a single declaration site. Must run before
  // `registerMobilityDataSource` so the provider's `attribution` field has
  // its data when the framework reads it.
  setManifestDataSources(ctx.manifest.dataSources ?? []);
  ctx.registerMobilityDataSource(fuelProvider);
  registerPlaceResolver(fuelProvider.id, createDataSourceResolver(fuelProvider));
}
