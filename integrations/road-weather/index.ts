import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createRoadWeatherDataSource } from "./data-source.js";

/**
 * The `road-weather` data source orchestrates every enabled integration that
 * registers a `RoadWeatherProvider` (domain `road-weather`); it fetches
 * nothing itself.
 */
export function setup(ctx: IntegrationContext): void {
  const source = createRoadWeatherDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
