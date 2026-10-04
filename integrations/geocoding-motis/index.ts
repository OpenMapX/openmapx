import type { IntegrationContext } from "@openmapx/integration-framework";
import { motisGeocodingService, setMotisLocalUrl, setTransitousUrl } from "./provider.js";
import { assertHttpUrlConfig } from "./validate-config-url.js";

export function setup(ctx: IntegrationContext): void {
  assertHttpUrlConfig(ctx.config.endpoint, "endpoint");
  assertHttpUrlConfig(ctx.config.transitousUrl, "transitousUrl");

  // The self-hosted MOTIS, if any: service registry → manifest config →
  // MOTIS_URL env, the same chain as transit-motis and live-transit-motis.
  // Without one every lookup goes to Transitous directly.
  const resolved = ctx.getRequiredService("motis");
  const url = [resolved?.url, ctx.config.endpoint, process.env.MOTIS_URL]
    .find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    )
    ?.trim();
  const transitousUrl = ctx.config.transitousUrl as string | undefined;
  ctx.onActivate(() => {
    setMotisLocalUrl(url);
    if (transitousUrl && transitousUrl.length > 0) setTransitousUrl(transitousUrl);
  });

  ctx.registerGeocodingProvider(motisGeocodingService);
}
