import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { initCache } from "@openmapx/integration-shared-mobility/cache";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { setDbBikeCredentials } from "./providers/db-bike-client.js";
import { bikeSharingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  setDbBikeCredentials({
    clientId: ctx.config.clientId as string | undefined,
    apiKey: ctx.config.apiKey as string | undefined,
  });
  ctx.registerProvider("data-source", bikeSharingProvider);
  registerPlaceResolver(bikeSharingProvider.id, createDataSourceResolver(bikeSharingProvider));
}
