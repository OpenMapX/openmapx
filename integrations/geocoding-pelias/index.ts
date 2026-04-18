import type { IntegrationContext } from "@openmapx/core";
import { peliasService, setPeliasUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("pelias");
  const url =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    process.env.PELIAS_URL ??
    "http://localhost:4000";

  setPeliasUrl(url);

  ctx.registerProvider("geocoding", peliasService);
}
