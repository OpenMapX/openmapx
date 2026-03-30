import type { IntegrationContext } from "@openmapx/core";
import { initCache } from "../bike-sharing/cache.js";
import { scooterSharingProvider } from "../bike-sharing/shared-providers/scooter-provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", scooterSharingProvider);
}
