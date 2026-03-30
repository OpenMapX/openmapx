import type { IntegrationContext } from "@openmapx/core";
import { maptilerGeocodingService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("geocoding", maptilerGeocodingService);
}
