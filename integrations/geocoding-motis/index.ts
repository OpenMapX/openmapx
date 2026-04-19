import type { IntegrationContext } from "@openmapx/core";
import { motisGeocodingService, setMotisLocalUrl, setTransitousUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("motis");
  const url =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "http://localhost:8081";
  setMotisLocalUrl(url);

  const transitousUrl = ctx.config.transitousUrl as string | undefined;
  if (transitousUrl && transitousUrl.length > 0) setTransitousUrl(transitousUrl);

  ctx.registerProvider("geocoding", motisGeocodingService);
}
