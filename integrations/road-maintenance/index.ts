import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createRoadMaintenanceDataSource } from "./data-source.js";

/**
 * The `road-maintenance` data source orchestrates every enabled integration
 * that registers a `ServiceVehicleProvider` (domain `service-vehicles`); it
 * fetches nothing itself.
 */
export function setup(ctx: IntegrationContext): void {
  const source = createRoadMaintenanceDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
