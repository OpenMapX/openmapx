import type { IntegrationContext } from "@openmapx/core";
import { peliasService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("geocoding", peliasService);
}
