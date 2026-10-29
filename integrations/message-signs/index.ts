import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createMessageSignDataSource } from "./data-source.js";

/**
 * The `message-signs` data source orchestrates every enabled integration that
 * registers a `MessageSignProvider` (domain `message-signs`); it fetches
 * nothing itself.
 */
export function setup(ctx: IntegrationContext): void {
  const source = createMessageSignDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
