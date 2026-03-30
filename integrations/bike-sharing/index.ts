import type { IntegrationContext } from "@openmapx/core";
import { initCache } from "./cache.js";
import { bikeSharingProvider } from "./shared-providers/bike-sharing-provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", bikeSharingProvider);
}
