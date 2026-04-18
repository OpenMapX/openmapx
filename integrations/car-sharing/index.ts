import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { initCache } from "@openmapx/integration-shared-mobility/cache";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { bielefeldClient } from "./providers/bielefeld-client.js";
import { cambioClient } from "./providers/cambio-client.js";
import { carSharingProvider } from "./providers/provider.js";
import { registerCarSharingClient } from "./providers/registry.js";
import { stadtteilAutoClient } from "./providers/stadtteilauto-client.js";
import { wuppertalClient } from "./providers/wuppertal-client.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);

  registerCarSharingClient(cambioClient);
  registerCarSharingClient(stadtteilAutoClient);
  registerCarSharingClient(wuppertalClient);
  registerCarSharingClient(bielefeldClient);

  ctx.registerProvider("data-source", carSharingProvider);
  registerPlaceResolver(carSharingProvider.id, createDataSourceResolver(carSharingProvider));
}
