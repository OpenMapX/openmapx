import { describe, expect, expectTypeOf, it } from "vitest";
import type { IntegrationContext } from "../../context";
import {
  assertProviderShape,
  PROVIDER_SHAPES,
  type ProviderDomain,
  type ProviderRegistrar,
} from "../provider-shapes";

const PROVIDER_REGISTRARS = [
  "registerTransitProvider",
  "registerRealtimeProvider",
  "registerMobilityDataSource",
  "registerWeatherProvider",
  "registerAirQualityProvider",
  "registerGeocodingProvider",
  "registerRoutingProvider",
  "registerRideProvider",
  "registerRoadConditionsProvider",
  "registerFuelStationProvider",
  "registerParkingSiteProvider",
  "registerChargingSiteProvider",
  "registerCameraProvider",
  "registerMessageSignProvider",
  "registerLandmarkModelProvider",
  "registerRoadWeatherProvider",
  "registerServiceVehicleProvider",
  "registerBorderCrossingProvider",
  "registerHazardsProvider",
  "registerPhotoProvider",
  "registerStreetLevelProvider",
  "registerReviewProvider",
  "registerPoiSearchProvider",
  "registerSearchSuggestionProvider",
  "registerKnowledgeProvider",
  "registerGtfsCatalogProvider",
] as const;

describe("PROVIDER_SHAPES", () => {
  it.each(Object.keys(PROVIDER_SHAPES))(
    "%s: a provider without its required members is refused",
    (domain) => {
      expect(() => assertProviderShape(domain as ProviderDomain, {}, "demo")).toThrow(
        /Integration demo: .* provider (is missing|has an invalid)/,
      );
    },
  );

  it("accepts a minimal routing provider", () => {
    expect(() =>
      assertProviderShape(
        "routing",
        { id: "x", supportedModes: ["driving"], getRoute: async () => ({}) },
        "demo",
      ),
    ).not.toThrow();
  });

  it("names the missing member", () => {
    expect(() => assertProviderShape("weather", { id: "x", priority: 1 }, "demo")).toThrow(
      "Integration demo: weather provider is missing getCurrentWeather",
    );
  });

  it("treats a method that is not a function as missing", () => {
    expect(() =>
      assertProviderShape("routing", { id: "x", supportedModes: [], getRoute: "no" }, "demo"),
    ).toThrow("Integration demo: routing provider is missing getRoute");
  });

  it("treats only an undefined prop as missing", () => {
    expect(() =>
      assertProviderShape("weather", { id: "x", priority: 0, getCurrentWeather() {} }, "demo"),
    ).not.toThrow();
    expect(() =>
      assertProviderShape(
        "weather",
        { id: "x", priority: undefined, getCurrentWeather() {} },
        "demo",
      ),
    ).toThrow("Integration demo: weather provider is missing priority");
  });

  it("finds methods a class declares on its prototype", () => {
    class Knowledge {
      readonly name = "wiki";
      async lookup() {
        return null;
      }
    }
    expect(() => assertProviderShape("knowledge", new Knowledge(), "demo")).not.toThrow();
  });

  it("refuses an empty, overlong or non-string key", () => {
    const route = { supportedModes: [], getRoute: async () => ({}) };
    for (const id of ["", "x".repeat(129), 7, undefined]) {
      expect(() => assertProviderShape("routing", { ...route, id }, "demo")).toThrow(
        "Integration demo: routing provider has an invalid id",
      );
    }
    expect(() =>
      assertProviderShape("routing", { ...route, id: "x".repeat(128) }, "demo"),
    ).not.toThrow();
    expect(() => assertProviderShape("knowledge", { lookup() {} }, "demo")).toThrow(
      "Integration demo: knowledge provider has an invalid name",
    );
  });

  it("asks a keyless geocoding provider only for its methods", () => {
    expect(() =>
      assertProviderShape(
        "geocoding",
        { geocode() {}, autocomplete() {}, reverseGeocode() {} },
        "demo",
      ),
    ).not.toThrow();
  });

  it("refuses a provider that is not an object", () => {
    expect(() => assertProviderShape("geocoding", null, "demo")).toThrow(
      "Integration demo: geocoding provider is missing geocode",
    );
  });

  it("covers every register* method of IntegrationContext", () => {
    expectTypeOf<ProviderRegistrar>().toEqualTypeOf<
      Exclude<
        Extract<keyof IntegrationContext, `register${string}`>,
        | "registerRoute"
        | "registerHealthCheck"
        | "registerDisclosure"
        | "registerSubjectDataHandler"
      >
    >();
    expectTypeOf<ProviderRegistrar>().toEqualTypeOf<(typeof PROVIDER_REGISTRARS)[number]>();
    const registrars = Object.values(PROVIDER_SHAPES).map(({ registrar }) => registrar);
    expect(new Set(registrars).size).toBe(registrars.length);
    expect([...registrars].sort()).toEqual([...PROVIDER_REGISTRARS].sort());
  });
});
