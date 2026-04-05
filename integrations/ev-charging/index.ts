import type { IntegrationContext } from "@openmapx/core";
import { initCache } from "./cache.js";
import { evChargingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", evChargingProvider);
}
