import type { IntegrationContext } from "@openmapx/integration-framework";
import { attribution } from "./attributions.js";
import { setupCloud } from "./cloud.js";
import { createTransitMotisInstances } from "./instances.js";
import { resolveLocalMotisUrl, setupLocal } from "./local.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => attribution.set(ctx.manifest.dataSources ?? []));
  const resolved = ctx.getRequiredService("motis");
  const localUrl = resolveLocalMotisUrl(resolved?.url, ctx.config.endpoint, process.env.MOTIS_URL);
  const instances = createTransitMotisInstances({
    localUrl,
    transitousUrl: ctx.config.transitousUrl as string | undefined,
    transitousUserAgent: ctx.config.transitousUserAgent as string | undefined,
  });
  ctx.log.info(`[transit-motis] configured local MOTIS endpoint: ${localUrl}`);
  setupLocal(ctx, instances);
  setupCloud(ctx, instances.transitousInstance);
}
