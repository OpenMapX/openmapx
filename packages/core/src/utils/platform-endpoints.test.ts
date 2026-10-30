import { describe, expect, it } from "vitest";
import {
  isHealthCheckEndpointId,
  platformEndpointServiceId,
  resolvePlatformEndpoint,
} from "./platform-endpoints";

describe("resolvePlatformEndpoint", () => {
  it("takes the enabled self-hosted service ahead of the operator's URL", () => {
    expect(
      resolvePlatformEndpoint("overpass", "http://overpass:80", {
        OVERPASS_URL: "https://overpass.example.org",
      }),
    ).toEqual({ url: "http://overpass:80", source: "service" });
  });

  it("takes the operator's URL without its API route or trailing slash", () => {
    expect(
      resolvePlatformEndpoint("overpass", null, {
        OVERPASS_URL: " https://overpass.example.org/api/interpreter/ ",
      }),
    ).toEqual({ url: "https://overpass.example.org", source: "operator" });
  });

  it("falls back to the public instance when nothing is configured", () => {
    expect(resolvePlatformEndpoint("overpass", undefined, { OVERPASS_URL: "  " })).toEqual({
      url: "https://overpass-api.de",
      source: "default",
    });
  });

  it("knows only the endpoints the contract names", () => {
    expect(isHealthCheckEndpointId("overpass")).toBe(true);
    expect(isHealthCheckEndpointId("nominatim")).toBe(false);
    expect(platformEndpointServiceId("overpass")).toBe("overpass");
  });
});
