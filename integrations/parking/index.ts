import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createParkingDataSource } from "./data-source.js";

/**
 * The `parking` data source orchestrates every enabled integration that
 * registers a `ParkingSiteProvider` (domain `parking-sites`); it fetches
 * nothing itself.
 */
export function setup(ctx: IntegrationContext): void {
  const source = createParkingDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
