import type { IntegrationContext } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { parkingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("data-source", parkingProvider);
  registerPlaceResolver(parkingProvider.id, createDataSourceResolver(parkingProvider));
}
