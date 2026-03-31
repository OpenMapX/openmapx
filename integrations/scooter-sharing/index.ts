import type { IntegrationContext } from "@openmapx/core";
import { initCache } from "@openmapx/integration-shared-mobility/cache";
import { scooterSharingProvider } from "@openmapx/integration-shared-mobility/scooter-provider";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", scooterSharingProvider);
}
