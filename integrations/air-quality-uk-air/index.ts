import type { IntegrationContext } from "@openmapx/integration-framework";

import { createUkAirProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerAirQualityProvider(createUkAirProvider(ctx));
}
