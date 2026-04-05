import type { IntegrationContext } from "@openmapx/core";
import { motisGeocodingService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("geocoding", motisGeocodingService);
}
