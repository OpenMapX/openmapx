import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { setTankerkoenigApiKey } from "./providers/factory.js";
import { fuelProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  setTankerkoenigApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerProvider("data-source", fuelProvider);
  registerPlaceResolver(fuelProvider.id, createDataSourceResolver(fuelProvider));
}
