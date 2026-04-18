import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { initCache } from "@openmapx/integration-shared-mobility/cache";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { bikeSharingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", bikeSharingProvider);
  registerPlaceResolver(bikeSharingProvider.id, createDataSourceResolver(bikeSharingProvider));
}
