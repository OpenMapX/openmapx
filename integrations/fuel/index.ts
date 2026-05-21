import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { setTankerkoenigApiKey } from "./providers/factory.js";
import { fuelProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setTankerkoenigApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerProvider("data-source", fuelProvider);
  registerPlaceResolver(fuelProvider.id, createDataSourceResolver(fuelProvider));
}
