import type { IntegrationContext } from "@openmapx/integration-framework";
import { attribution } from "./attributions.js";
import { setupCloud } from "./cloud.js";
import { createTransitMotisInstances, createTransitousInstance } from "./instances.js";
import { setupLocal } from "./local.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => attribution.set(ctx.manifest.dataSources ?? []));
  // The self-hosted MOTIS, if any: the service, the `endpoint` setting or MOTIS_URL.
  const localUrl = ctx.resolvePlatformEndpoint("motis")?.url;
  const transitous = {
    transitousUrl: ctx.resolvePlatformEndpoint("transitous")?.url,
    transitousUserAgent: ctx.config.transitousUserAgent as string | undefined,
  };
  if (!localUrl) {
    // No self-hosted MOTIS: Transitous is the transit engine, not a fallback.
    ctx.log.info("[transit-motis] no local MOTIS configured; serving transit from Transitous");
    setupCloud(ctx, createTransitousInstance(transitous), "primary");
    return;
  }
  const instances = createTransitMotisInstances({ localUrl, ...transitous });
  ctx.log.info(`[transit-motis] configured local MOTIS endpoint: ${localUrl}`);
  setupLocal(ctx, instances);
  setupCloud(ctx, instances.transitousInstance, "fallback");
}
