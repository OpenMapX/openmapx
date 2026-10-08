import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createEvChargingDataSource } from "./data-source.js";

/**
 * The `ev-charging` data source orchestrates every enabled integration that
 * registers a `ChargingSiteProvider` (domain `charging-sites`); it fetches
 * nothing itself.
 */
export function setup(ctx: IntegrationContext): void {
  const source = createEvChargingDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
