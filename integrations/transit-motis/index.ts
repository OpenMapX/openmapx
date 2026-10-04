import type { IntegrationContext } from "@openmapx/integration-framework";
import { attribution } from "./attributions.js";
import { setupCloud } from "./cloud.js";
import { createTransitMotisInstances, createTransitousInstance } from "./instances.js";
import { resolveLocalMotisUrl, setupLocal } from "./local.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => attribution.set(ctx.manifest.dataSources ?? []));
  const resolved = ctx.getRequiredService("motis");
  const localUrl = resolveLocalMotisUrl(resolved?.url, ctx.config.endpoint, process.env.MOTIS_URL);
  const transitous = {
    transitousUrl: ctx.config.transitousUrl as string | undefined,
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
