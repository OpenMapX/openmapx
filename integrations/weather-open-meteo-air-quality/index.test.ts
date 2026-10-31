import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { expect, it } from "vitest";

import { setup } from "./index.js";

it("serves Open-Meteo air quality only through the canonical air-quality API", () => {
  const ctx = createMockIntegrationContext({ id: "weather-open-meteo-air-quality" });
  setup(ctx);
  expect(ctx.registered.airQuality).toHaveLength(1);
  // The deprecated `/aqi` route, superseded by `/api/integrations/air-quality/current`, is gone.
  expect(ctx.registered.routes).toEqual([]);
});
