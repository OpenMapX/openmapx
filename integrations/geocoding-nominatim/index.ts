import type { IntegrationContext } from "@openmapx/integration-framework";
import { nominatimService, setNominatimUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => setNominatimUrl(ctx.resolvePlatformEndpoint("nominatim")?.url));

  ctx.registerGeocodingProvider(nominatimService);
}
