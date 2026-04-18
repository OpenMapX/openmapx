import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { initCache } from "@openmapx/integration-shared-mobility/cache";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { scooterSharingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  ctx.registerProvider("data-source", scooterSharingProvider);
  registerPlaceResolver(
    scooterSharingProvider.id,
    createDataSourceResolver(scooterSharingProvider),
  );
}
