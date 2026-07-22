import { describe, expect, it } from "vitest";
import { integrationEnvVarName } from "../env-var.js";

describe("integrationEnvVarName", () => {
  it("normalizes hyphens in both id and key", () => {
    expect(integrationEnvVarName("fuel", "de-tankerkoenig-api-key")).toBe(
      "INTEGRATION_FUEL_DE_TANKERKOENIG_API_KEY",
    );
  });
  it("handles hyphenated integration ids", () => {
    expect(integrationEnvVarName("ev-charging", "us-afdc-api-key")).toBe(
      "INTEGRATION_EV_CHARGING_US_AFDC_API_KEY",
    );
  });
  it("leaves bare camelCase keys intact", () => {
    expect(integrationEnvVarName("geocoding-maptiler", "apiKey")).toBe(
      "INTEGRATION_GEOCODING_MAPTILER_APIKEY",
    );
  });
});
