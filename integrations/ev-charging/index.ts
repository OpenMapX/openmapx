import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { initCache } from "./cache.js";
import { evChargingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", evChargingProvider);
  registerPlaceResolver(evChargingProvider.id, createDataSourceResolver(evChargingProvider));
}
