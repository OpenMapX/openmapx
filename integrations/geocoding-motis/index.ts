import type { IntegrationContext } from "@openmapx/core";
import { motisGeocodingService, setMotisLocalUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("motis");
  const url =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    process.env.MOTIS_URL ??
    "http://localhost:8081";
  setMotisLocalUrl(url);

  ctx.registerProvider("geocoding", motisGeocodingService);
}
