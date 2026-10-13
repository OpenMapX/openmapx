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

  it("resolves only explicitly named legacy suppliers", () => {
    expect(routeAttributions(registry, "routing-osrm", {})).toEqual([]);
    expect(
      routeAttributions(registry, "routing-osrm", { sourceIds: ["osrm"] }).map((a) => a.name),
    ).toEqual(["OSRM"]);
    expect(routeAttributions(registry, "routing-osrm", null)).toEqual([]);
  });

  it("credits nothing without a provider", () => {
    expect(routeAttributions(registry, undefined, { sourceIds: ["valhalla"] })).toEqual([]);
    expect(routeAttributions(registry, "unknown", { sourceIds: ["valhalla"] })).toEqual([]);
  });
});

it("keeps captured mixed provider credits and explicit empty snapshots", () => {
  const a = { sourceId: "a", name: "A", attributionText: "notice A" };
  const b = { sourceId: "a", name: "A", attributionText: "notice B" };
  expect(routeAttributions(registry, "unknown", { contributors: [a, b] })).toEqual([a, b]);
  expect(routeAttributions(registry, "routing-osrm", { contributors: [] })).toEqual([]);
  expect(routeAttributions(registry, "routing-valhalla", {})).toEqual([]);
});

it("projects only drawn geometry or displayed duration from captured field receipts", () => {
  const geometry = { sourceId: "geometry", name: "Geometry" };
  const summary = { sourceId: "summary", name: "Summary" };
  const route = {
    contributors: [geometry, summary],
    fieldContributors: { geometry: [geometry], duration: [] },
  };
  expect(routeAttributions(registry, "unknown", route, ["geometry"])).toEqual([geometry]);
  expect(routeAttributions(registry, "unknown", route, ["duration"])).toEqual([]);
  expect(routeAttributions(registry, "unknown", route, ["summary"])).toEqual([]);
});
