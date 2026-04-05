import type { IntegrationContext } from "@openmapx/core";
import { initCache } from "@openmapx/integration-shared-mobility/cache";
import { scooterSharingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", scooterSharingProvider);
}
