import { createHash } from "node:crypto";
import { effectiveProviderOrder, type LoadedIntegration } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { PoiSearchProvider, PoiSearchResult } from "@openmapx/provider-kit/poi-search";
import { describe, expect, it, vi } from "vitest";
import { createPoiSearchOrchestrator } from "../orchestrator";

const BBOX = { south: 52.49, west: 13.38, north: 52.53, east: 13.43 };

function result(id: string, longitude: number): PoiSearchResult {
  return { id, name: id, coordinates: [longitude, 52.51], category: "cafes" };
}

function poiProvider(
  id: string,
  results: PoiSearchResult[],
  extra: Partial<PoiSearchProvider> = {},
): PoiSearchProvider {
  return {
    id,
    categories: ["cafes"],
    search: vi.fn(async () => results),
    ...extra,
  };
}

function integration(id: string, provider: PoiSearchProvider): LoadedIntegration {
  return {
    id,
    config: {},
    manifest: { id, domains: ["poi-search"] },
    providers: new Map([["poi-search", [provider]]]),
  } as unknown as LoadedIntegration;
}

function hostLike(integrations: LoadedIntegration[], order: readonly string[] = []) {
  const ctx = createMockIntegrationContext({
    id: "poi-search",
    providerOrder: { "poi-search": order },
  });
  ctx.getIntegrationsByDomain = (domain) => (domain === "poi-search" ? integrations : []);
  return ctx;
}

describe("POI providers without provider ids", () => {
  it("fuses onto the provider that declares itself the base, whatever its id", async () => {
    // Far apart, so neither is merged into the other: only the roles decide.
    const augment = poiProvider("overpass", [result("osm:node/1", 13.39)], {
      fusionRole: "augment",
    });
    const base = poiProvider("acme-pois", [result("acme:1", 13.42)], { fusionRole: "base" });
    const execute = vi.fn(async (_query: string, _params?: unknown[]) => []);
    const ctx = hostLike([integration("poi-overpass", augment), integration("poi-acme", base)]);
    Object.assign(ctx, { db: { execute } });
    const response = await createPoiSearchOrchestrator(ctx).search("cafes", BBOX);
    expect(response.results.map((entry) => entry.id).sort()).toEqual(["acme:1", "osm:node/1"]);
    // Conflation links are looked up for the base's results only.
    expect(execute).not.toHaveBeenCalled();
    const baseFails = poiProvider("acme-pois", [], { fusionRole: "base" });
    baseFails.search = vi.fn(async () => {
      throw new Error("base unavailable");
    });
    const failed = await createPoiSearchOrchestrator(
      hostLike([integration("poi-overpass", augment), integration("poi-acme", baseFails)]),
    ).search("cafes", BBOX);
    expect(failed.results.map((entry) => entry.id)).toEqual(["osm:node/1"]);
    expect(failed.partial).toBe(true);
  });

  it("falls back to the first provider when none declares a base", async () => {
    const first = poiProvider("acme-pois", [result("osm:node/7", 13.4)]);
    const second = poiProvider("other-pois", [result("other:1", 13.42)]);
    const execute = vi.fn(async (_query: string, _params?: unknown[]) => []);
    const ctx = hostLike(
      [integration("poi-other", second), integration("poi-acme", first)],
      ["poi-acme", "poi-other"],
    );
    Object.assign(ctx, { db: { execute } });
    await createPoiSearchOrchestrator(ctx).search("cafes", BBOX);
    // Only a base's results are looked up in the conflation link table.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["node", 7n]));
  });

  it("uses the operator's order to pick the text-search provider", async () => {
    const searchText = (id: string) => vi.fn(async () => [result(`${id}:text`, 13.4)]);
    const acme = poiProvider("acme-pois", [], { searchText: searchText("acme") });
    const overpass = poiProvider("overpass", [], {
      fusionRole: "base",
      searchText: searchText("overpass"),
    });
    const integrations = [integration("poi-overpass", overpass), integration("poi-acme", acme)];
    const pick = async (order: string[]) =>
      (await createPoiSearchOrchestrator(hostLike(integrations, order)).searchText("q", BBOX))
        .results[0]?.id;
    expect(await pick(["poi-acme"])).toBe("acme:text");
    expect(await pick(["poi-overpass", "poi-acme"])).toBe("overpass:text");
    expect(await pick([])).toBe("overpass:text");
  });
});

describe("served POI order, fingerprint and admin list", () => {
  it("agree on the served sequence", () => {
    const integrations = [
      integration("poi-overpass", poiProvider("overpass", [], { fusionRole: "base" })),
      integration("poi-overture", poiProvider("overture", [])),
      integration("poi-acme", poiProvider("acme-pois", [])),
    ];
    const order = ["poi-acme", "ghost"];
    const ctx = hostLike(integrations, order);
    const served = createPoiSearchOrchestrator(ctx)
      .getProviders()
      .map((provider) => provider.id);
    expect(served).toEqual(["acme-pois", "overpass", "overture"]);
    expect(
      effectiveProviderOrder(order, integrations, "poi-search").map((entry) => entry.integrationId),
    ).toEqual(["poi-acme", "poi-overpass", "poi-overture"]);
    expect(ctx.getProviderOrderFingerprint("poi-search")).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            ["poi-acme", "acme-pois"],
            ["poi-overpass", "overpass"],
            ["poi-overture", "overture"],
          ]),
        )
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("keeps the built-in fusion and search choices with the default configuration", async () => {
    const overpassSearchText = vi.fn(async () => [result("osm:text", 13.4)]);
    const overpass = poiProvider("overpass", [result("osm:node/1", 13.39)], {
      fusionRole: "base",
      searchText: overpassSearchText,
    });
    const overture = poiProvider("overture", [result("overture:1", 13.42)]);
    const execute = vi.fn(async (_query: string, _params?: unknown[]) => []);
    // Overture registered first: the base is still Overpass, as it was by id.
    const ctx = hostLike([
      integration("poi-overture", overture),
      integration("poi-overpass", overpass),
    ]);
    Object.assign(ctx, { db: { execute } });
    const orchestrator = createPoiSearchOrchestrator(ctx);
    await orchestrator.search("cafes", BBOX);
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["node", 1n]));
    expect((await orchestrator.searchText("q", BBOX)).results[0]?.id).toBe("osm:text");
  });
});
