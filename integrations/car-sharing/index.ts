import type { IntegrationContext } from "@openmapx/core";
import { initCache } from "@openmapx/integration-shared-mobility/cache";
import { carSharingProvider } from "@openmapx/integration-shared-mobility/car-sharing-provider";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", carSharingProvider);
}
