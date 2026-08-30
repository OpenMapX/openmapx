import type { IntegrationContext } from "@openmapx/integration-framework";

import { createEcccAirQualityProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerAirQualityProvider(createEcccAirQualityProvider(ctx));
}
