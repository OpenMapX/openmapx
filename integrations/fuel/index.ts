import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createFuelDataSource } from "./data-source.js";

/**
 * The `fuel` data source orchestrates every enabled integration that registers
 * a `FuelStationProvider` (domain `fuel-stations`); it fetches nothing itself.
 */
export function setup(ctx: IntegrationContext): void {
  const source = createFuelDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
