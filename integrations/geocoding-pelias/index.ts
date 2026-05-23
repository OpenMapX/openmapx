import type { IntegrationContext } from "@openmapx/integration-framework";
import { peliasService, setPeliasUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("pelias");
  const url =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "http://localhost:4300";

  setPeliasUrl(url);

  ctx.registerGeocodingProvider(peliasService);
}
