import type { IntegrationContext } from "@openmapx/core";
import { initCache } from "../bike-sharing/cache.js";
import { carSharingProvider } from "../bike-sharing/shared-providers/car-sharing-provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", carSharingProvider);
}
