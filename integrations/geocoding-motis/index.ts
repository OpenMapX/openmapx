import type { IntegrationContext } from "@openmapx/integration-framework";
import { motisGeocodingService, setMotisLocalUrl, setTransitousUrl } from "./provider.js";
import { assertHttpUrlConfig } from "./validate-config-url.js";

export function setup(ctx: IntegrationContext): void {
  assertHttpUrlConfig(ctx.config.endpoint, "endpoint");
  assertHttpUrlConfig(ctx.config.transitousUrl, "transitousUrl");

  // Resolution order: service registry → manifest config → MOTIS_URL env →
  // localhost fallback. Mirrors transit-motis-local + live-transit-motis +
  // services/data-manager so ops can set MOTIS_URL once for the whole stack.
  const resolved = ctx.getRequiredService("motis");
  const url =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    process.env.MOTIS_URL ??
    "http://localhost:8081";
  const transitousUrl = ctx.config.transitousUrl as string | undefined;
  ctx.onActivate(() => {
    setMotisLocalUrl(url);
    if (transitousUrl && transitousUrl.length > 0) setTransitousUrl(transitousUrl);
  });

  ctx.registerGeocodingProvider(motisGeocodingService);
}
