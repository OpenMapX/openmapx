import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createWebcamDataSource } from "./data-source.js";

/**
 * The `webcam` data source orchestrates every enabled integration that
 * registers a `CameraProvider` (domain `cameras`); it fetches nothing itself.
 */
export function setup(ctx: IntegrationContext): void {
  const source = createWebcamDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
