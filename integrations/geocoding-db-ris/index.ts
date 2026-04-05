import type { IntegrationContext } from "@openmapx/core";
import { dbRisGeocodingService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("geocoding", dbRisGeocodingService);
}
