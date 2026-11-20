import type { IntegrationContext } from "@openmapx/integration-framework";
import { createLandmarkIndexSource, createRoutes } from "./routes";

/**
 * Orchestrator of the `landmark-models` domain: merges every provider's
 * catalogue and serves it by z12 cell. Providers are looked up per request,
 * so enabling or disabling one needs no change here.
 */
export async function setup(ctx: IntegrationContext): Promise<void> {
  const routes = createRoutes(createLandmarkIndexSource(ctx));
  ctx.registerRoute("GET", "/coverage", routes.coverage, { rateLimitTier: "public" });
  ctx.registerRoute("GET", "/cells/:x/:y", routes.cell, { rateLimitTier: "public" });
}
