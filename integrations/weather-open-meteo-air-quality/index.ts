import type { IntegrationContext } from "@openmapx/integration-framework";

import { createOpenMeteoAirQualityProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerAirQualityProvider(createOpenMeteoAirQualityProvider(ctx));
}
