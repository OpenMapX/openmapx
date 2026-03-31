import { initCache } from "@integrations/shared-mobility/cache";
import { scooterSharingProvider } from "@integrations/shared-mobility/scooter-provider";
import type { IntegrationContext } from "@openmapx/core";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", scooterSharingProvider);
}
