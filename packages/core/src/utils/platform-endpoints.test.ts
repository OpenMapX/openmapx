import { describe, expect, it } from "vitest";
import {
  isPlatformEndpointId,
  platformEndpointServiceId,
  resolvePlatformEndpoint,
} from "./platform-endpoints";

describe("resolvePlatformEndpoint", () => {
  it("ranks the self-hosted service, the integration setting, the operator URL, then the default", () => {
    const env = { NOMINATIM_URL: "https://nominatim.operator.example" };
    const setting = "http://nominatim.lan:8080/";

    expect(
      resolvePlatformEndpoint(
        "nominatim",
        { selfHostedUrl: "http://nominatim:8080", configuredUrl: setting },
        env,
      ),
    ).toEqual({ url: "http://nominatim:8080", source: "service" });
    expect(resolvePlatformEndpoint("nominatim", { configuredUrl: setting }, env)).toEqual({
      url: "http://nominatim.lan:8080",
      source: "setting",
    });
    expect(resolvePlatformEndpoint("nominatim", { configuredUrl: "  " }, env)).toEqual({
      url: "https://nominatim.operator.example",
      source: "operator",
    });
    expect(resolvePlatformEndpoint("nominatim", {}, {})).toEqual({
      url: "https://nominatim.openstreetmap.org",
      source: "default",
    });
  });

  it("takes the operator's Overpass URL without its API route or trailing slashes", () => {
    expect(
      resolvePlatformEndpoint(
        "overpass",
        { selfHostedUrl: null },
        { OVERPASS_URL: " https://overpass.example.org/api/interpreter// " },
      ),
    ).toEqual({ url: "https://overpass.example.org", source: "operator" });
  });

  it("has no self-hosted MOTIS unless one is configured, and a public Transitous", () => {
    expect(resolvePlatformEndpoint("motis", {}, {})).toBeNull();
    expect(resolvePlatformEndpoint("motis", {}, { MOTIS_URL: "http://motis.lan:8080" })).toEqual({
      url: "http://motis.lan:8080",
      source: "operator",
    });
    expect(resolvePlatformEndpoint("transitous", {}, {})).toEqual({
      url: "https://api.transitous.org",
      source: "default",
    });
  });

  it("ignores a non-string integration setting", () => {
    expect(resolvePlatformEndpoint("transitous", { configuredUrl: 42 }, {})?.source).toBe(
      "default",
    );
  });

  it("knows only the endpoints the contract names, and which service self-hosts each", () => {
    const ids = ["overpass", "nominatim", "photon", "pelias", "osrm", "valhalla", "motis"];
    expect([...ids, "transitous"].every(isPlatformEndpointId)).toBe(true);
    expect(isPlatformEndpointId("geoserver")).toBe(false);
    expect(platformEndpointServiceId("motis")).toBe("motis");
    expect(platformEndpointServiceId("transitous")).toBeNull();
  });
});
