import type { IntegrationContext } from "@openmapx/core";
import { nominatimService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("geocoding", nominatimService);
}
