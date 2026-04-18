import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { initCache } from "./cache.js";
import { webcamProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", webcamProvider);
  registerPlaceResolver(webcamProvider.id, createDataSourceResolver(webcamProvider));
}
