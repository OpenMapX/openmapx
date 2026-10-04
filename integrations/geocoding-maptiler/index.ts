import type { IntegrationContext } from "@openmapx/integration-framework";
import { maptilerGeocodingService, resolveMaptilerApiKey, setMaptilerApiKey } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() =>
    setMaptilerApiKey(resolveMaptilerApiKey(ctx.config.apiKey as string | undefined)),
  );
  ctx.registerGeocodingProvider(maptilerGeocodingService);
}
