import type { IntegrationContext } from "@openmapx/core";
import { maptilerGeocodingService, setMaptilerApiKey } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  setMaptilerApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerProvider("geocoding", maptilerGeocodingService);
}
