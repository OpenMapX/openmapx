import type { IntegrationContext } from "@openmapx/integration-framework";
import { maptilerGeocodingService, setMaptilerApiKey } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  setMaptilerApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerGeocodingProvider(maptilerGeocodingService);
}
