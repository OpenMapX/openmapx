import type { IntegrationContext } from "@openmapx/integration-framework";
import { createModelProxy } from "./model-proxy";
import { createLandmarkIndexSource, createRoutes, landmarkProviders } from "./routes";

/**
 * Orchestrator of the `landmark-models` domain: merges every provider's
 * catalogue, serves it by z12 cell and proxies the model files. Providers are
 * looked up per request, so enabling or disabling one needs no change here.
 */
export async function setup(ctx: IntegrationContext): Promise<void> {
  const routes = createRoutes(createLandmarkIndexSource(ctx));
  const models = createModelProxy(ctx);
  ctx.onShutdown(async () => models.stop());
  ctx.registerRoute("GET", "/coverage", routes.coverage, { rateLimitTier: "public" });
  ctx.registerRoute("GET", "/cells/:x/:y", routes.cell, { rateLimitTier: "public" });
  ctx.registerRoute("GET", "/models/:provider/:sha256.glb", models.handle, {
    rateLimitTier: "tile",
  });
  ctx.registerHealthCheck(async () => {
    const providers = landmarkProviders(ctx);
    if (providers.length === 0) return { status: "unconfigured" };
    return providers.some((provider) => provider.snapshot())
      ? { status: "up" }
      : { status: "down", error: "No landmark catalogue loaded yet" };
  });
}
