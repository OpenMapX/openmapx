import { initCache } from "@integrations/shared-mobility/cache";
import { carSharingProvider } from "@integrations/shared-mobility/car-sharing-provider";
import type { IntegrationContext } from "@openmapx/core";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", carSharingProvider);
}
