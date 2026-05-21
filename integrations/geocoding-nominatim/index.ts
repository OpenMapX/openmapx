import type { IntegrationContext } from "@openmapx/integration-framework";
import { nominatimService, setNominatimUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("nominatim");
  const url =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    "https://nominatim.openstreetmap.org";

  setNominatimUrl(url);

  ctx.registerProvider("geocoding", nominatimService);
}
