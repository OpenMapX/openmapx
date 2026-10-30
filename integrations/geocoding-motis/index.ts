import type { IntegrationContext } from "@openmapx/integration-framework";
import { motisGeocodingService, setMotisLocalUrl, setTransitousUrl } from "./provider.js";
import { assertHttpUrlConfig } from "./validate-config-url.js";

export function setup(ctx: IntegrationContext): void {
  assertHttpUrlConfig(ctx.config.endpoint, "endpoint");
  assertHttpUrlConfig(ctx.config.transitousUrl, "transitousUrl");

  // The self-hosted MOTIS, if any: the service, the `endpoint` setting or
  // MOTIS_URL. Without one every lookup goes to Transitous directly.
  const url = ctx.resolvePlatformEndpoint("motis")?.url;
  const transitousUrl = ctx.resolvePlatformEndpoint("transitous")?.url;
  ctx.onActivate(() => {
    setMotisLocalUrl(url);
    if (transitousUrl) setTransitousUrl(transitousUrl);
  });

  ctx.registerGeocodingProvider(motisGeocodingService);
}
