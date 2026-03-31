import { bikeSharingProvider } from "@integrations/shared-mobility/bike-sharing-provider";
import { initCache } from "@integrations/shared-mobility/cache";
import type { IntegrationContext } from "@openmapx/core";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", bikeSharingProvider);
}
