import { describe, expect, it } from "vitest";
import { integrationEnvVarName } from "../env-var.js";
import { integrationManifestSchema } from "../manifest";

describe("integration config keys", () => {
  const accepts = (key: string) =>
    integrationManifestSchema.safeParse({
      id: "probe",
      domains: ["geocoding"],
      configSchema: { type: "object", properties: { [key]: { type: "string" } } },
    }).success;

  it("accepts lowerCamel keys whose variable names exactly one key", () => {
    for (const key of ["endpoint", "apiKey", "gofsCustom1ApiKey", "rateLimitPerIpPerHour"])
      expect(accepts(key), key).toBe(true);
  });

  it("refuses keys whose words the variable cannot tell apart", () => {
    // `dbBikeAPIKey` would be DB_BIKE_APIKEY, which reads back as `dbBikeApikey`.
    for (const key of ["dbBikeAPIKey", "keyA", "rate-limit", "api_key", "ApiKey"])
      expect(accepts(key), key).toBe(false);
  });
});

describe("integrationEnvVarName", () => {
  it("splits the words of a lowerCamel key", () => {
    expect(integrationEnvVarName("geocoding-maptiler", "apiKey")).toBe(
      "INTEGRATION_GEOCODING_MAPTILER_API_KEY",
    );
    expect(integrationEnvVarName("search-nlp", "rateLimitPerIpPerHour")).toBe(
      "INTEGRATION_SEARCH_NLP_RATE_LIMIT_PER_IP_PER_HOUR",
    );
    expect(integrationEnvVarName("street-level-imagery", "mapillaryAccessToken")).toBe(
      "INTEGRATION_STREET_LEVEL_IMAGERY_MAPILLARY_ACCESS_TOKEN",
    );
  });
  it("handles hyphenated integration ids and digits", () => {
    expect(integrationEnvVarName("ev-charging", "usAfdcApiKey")).toBe(
      "INTEGRATION_EV_CHARGING_US_AFDC_API_KEY",
    );
    expect(integrationEnvVarName("ride-gofs", "gofsCustom1ApiKey")).toBe(
      "INTEGRATION_RIDE_GOFS_GOFS_CUSTOM1_API_KEY",
    );
  });
  it("keeps a single-word key", () => {
    expect(integrationEnvVarName("routing-osrm", "endpoint")).toBe(
      "INTEGRATION_ROUTING_OSRM_ENDPOINT",
    );
  });
});
