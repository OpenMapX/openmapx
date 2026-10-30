import type { IntegrationContext } from "@openmapx/integration-framework";
import { peliasService, setPeliasUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => setPeliasUrl(ctx.resolvePlatformEndpoint("pelias")?.url));

  ctx.registerGeocodingProvider(peliasService);
}
