import type { IntegrationContext } from "@openmapx/integration-framework";
import { resolveEndpoint } from "@openmapx/integration-geocoding/endpoint";
import { peliasService, setPeliasUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => setPeliasUrl(resolveEndpoint(ctx, "pelias", "http://localhost:4300")));

  ctx.registerGeocodingProvider(peliasService);
}
