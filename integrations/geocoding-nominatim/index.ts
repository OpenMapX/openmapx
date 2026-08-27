import type { IntegrationContext } from "@openmapx/integration-framework";
import { resolveEndpoint } from "@openmapx/integration-geocoding/endpoint";
import { nominatimService, setNominatimUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() =>
    setNominatimUrl(resolveEndpoint(ctx, "nominatim", "https://nominatim.openstreetmap.org")),
  );

  ctx.registerGeocodingProvider(nominatimService);
}
