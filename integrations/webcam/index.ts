import type { IntegrationContext } from "@openmapx/core";
import { initCache } from "./cache.js";
import { webcamProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", webcamProvider);
}
