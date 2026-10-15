import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createBorderCrossingDataSource } from "./data-source.js";

/**
 * The `border-crossings` data source orchestrates every enabled integration
 * that registers a `BorderCrossingProvider` (domain `border-crossings`); it
 * fetches nothing itself.
 */
export function setup(ctx: IntegrationContext): void {
  const source = createBorderCrossingDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
