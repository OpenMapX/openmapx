import type { IntegrationContext } from "@openmapx/core";
import { bikeSharingProvider } from "@openmapx/integration-shared-mobility/bike-sharing-provider";
import { initCache } from "@openmapx/integration-shared-mobility/cache";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", bikeSharingProvider);
}
