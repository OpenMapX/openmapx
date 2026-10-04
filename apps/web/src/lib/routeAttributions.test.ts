import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import type { ProviderMetaResolver } from "./attributionForProviders";
import { routeAttributions } from "./routeAttributions";

function ds(sourceId: string, name: string): IntegrationDataSource {
  return {
    sourceId,
    name,
    url: `https://example.com/${sourceId}`,
    license: "MIT",
    providerCountry: "XX",
    providerPrivacyUrl: "-",
  };
}

const registry: ProviderMetaResolver = {
  get: (id) =>
    id === "routing-valhalla"
      ? { dataSources: [ds("valhalla", "Valhalla"), ds("stadia-maps", "Stadia Maps")] }
      : id === "routing-osrm"
        ? { dataSources: [ds("osrm", "OSRM")] }
        : undefined,
};

describe("routeAttributions", () => {
  it("credits only the backend the route reports", () => {
    const credits = routeAttributions(registry, "routing-valhalla", { sourceIds: ["valhalla"] });
    expect(credits.map((a) => a.name)).toEqual(["Valhalla"]);
  });

  it("credits Stadia Maps when Stadia computed the route", () => {
    const credits = routeAttributions(registry, "routing-valhalla", { sourceIds: ["stadia-maps"] });
    expect(credits.map((a) => a.name)).toEqual(["Stadia Maps"]);
  });

  it("falls back to every declared source when the route reports none", () => {
    expect(routeAttributions(registry, "routing-osrm", {}).map((a) => a.name)).toEqual(["OSRM"]);
    expect(routeAttributions(registry, "routing-osrm", null).map((a) => a.name)).toEqual(["OSRM"]);
  });

  it("credits nothing without a provider", () => {
    expect(routeAttributions(registry, undefined, { sourceIds: ["valhalla"] })).toEqual([]);
    expect(routeAttributions(registry, "unknown", { sourceIds: ["valhalla"] })).toEqual([]);
  });
});
