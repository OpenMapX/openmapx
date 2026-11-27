import { createHash } from "node:crypto";
import { effectiveProviderOrder, type LoadedIntegration } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  routeRequest,
} from "@openmapx/integration-framework/testing";
import type { PoiSearchProvider, PoiSearchResult } from "@openmapx/provider-kit/poi-search";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";
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
    const base = poiProvider("acme-pois", [result("osm:node/2", 13.42)], { fusionRole: "base" });
    const execute = vi.fn(async (_query: string, _params?: unknown[]) => []);
    const ctx = hostLike([integration("poi-overpass", augment), integration("poi-acme", base)]);
    Object.assign(ctx, { db: { execute } });
    const response = await createPoiSearchOrchestrator(ctx).search("cafes", BBOX);
    expect(response.results.map((entry) => entry.id).sort()).toEqual(["osm:node/1", "osm:node/2"]);
    // Conflation links are looked up for the base's results only.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["node", 2n]));
    expect(execute.mock.calls[0]?.[1]).not.toEqual(expect.arrayContaining([1n]));
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

  it("has no base for a category the declared base does not cover", async () => {
    const overpass = poiProvider("overpass", [], { fusionRole: "base", categories: ["bakeries"] });
    const acme = poiProvider("acme-pois", [result("osm:node/4", 13.39)], {
      fusionRole: "augment",
    });
    const overture = poiProvider("overture", [result("osm:node/5", 13.42)]);
    const execute = vi.fn(async (_query: string, _params?: unknown[]) => []);
    const ctx = hostLike(
      [
        integration("poi-overpass", overpass),
        integration("poi-overture", overture),
        integration("poi-acme", acme),
      ],
      ["poi-acme", "poi-overture"],
    );
    Object.assign(ctx, { db: { execute } });
    const response = await createPoiSearchOrchestrator(ctx).search("cafes", BBOX);
    expect(response.results.map((entry) => entry.id).sort()).toEqual(["osm:node/4", "osm:node/5"]);
    // Neither covering provider is promoted: every one augments an empty set.
    expect(execute).not.toHaveBeenCalled();
    expect(overpass.search).not.toHaveBeenCalled();
  });

  it("never promotes a provider that declares itself an augment", async () => {
    const first = poiProvider("acme-pois", [result("osm:node/8", 13.39)], {
      fusionRole: "augment",
    });
    const second = poiProvider("other-pois", [result("osm:node/9", 13.42)], {
      fusionRole: "augment",
    });
    const execute = vi.fn(async (_query: string, _params?: unknown[]) => []);
    const ctx = hostLike([integration("poi-acme", first), integration("poi-other", second)]);
    Object.assign(ctx, { db: { execute } });
    const response = await createPoiSearchOrchestrator(ctx).search("cafes", BBOX);
    expect(response.results.map((entry) => entry.id).sort()).toEqual(["osm:node/8", "osm:node/9"]);
    expect(execute).not.toHaveBeenCalled();
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
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["node", 1n]));
    expect((await orchestrator.searchText("q", BBOX)).results[0]?.id).toBe("osm:text");

    // An operator who puts Overture first does not make it the base.
    execute.mockClear();
    const reordered = hostLike(
      [integration("poi-overture", overture), integration("poi-overpass", overpass)],
      ["poi-overture", "poi-overpass"],
    );
    Object.assign(reordered, { db: { execute } });
    await createPoiSearchOrchestrator(reordered).search("cafes", BBOX);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["node", 1n]));
  });
});

describe("POI result caches", () => {
  const reply = { header: () => reply, status: () => reply, send: () => reply, type: () => reply };
  const empty = { results: [], partial: false, truncated: false, total: 0 };
  const box = { south: "52.49", west: "13.38", north: "52.53", east: "13.43" };
  const requests = [
    ["GET", "/search", { query: { category: "cafes", ...box }, body: null }],
    ["GET", "/text", { query: { q: "cafe", ...box }, body: null }],
    ["GET", "/filtered", { query: { category: "cafes", ...box }, body: null }],
    [
      "POST",
      "/filter",
      {
        query: {},
        body: {
          filter: { selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }] },
          ...Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Number(value)])),
        },
      },
    ],
  ] as const;

  it("key category, text, filtered and filter results by the provider order", async () => {
    const ctx = hostLike([
      integration("poi-overpass", poiProvider("overpass", [], { fusionRole: "base" })),
      integration("poi-acme", poiProvider("acme-pois", [])),
    ]);
    const keys: string[] = [];
    ctx.cache.withCache = async <T>(key: string) => {
      keys.push(key);
      return empty as T;
    };
    setup(ctx);
    const readAll = async () => {
      for (const [method, path, request] of requests) {
        const route = ctx.registered.routes.find(
          (entry) => entry.method === method && entry.path === path,
        );
        if (!route) throw new Error(`missing ${method} ${path}`);
        await route.handler(routeRequest(request), reply);
      }
      return keys.splice(0);
    };
    const first = await readAll();
    expect(first).toHaveLength(requests.length);
    expect(await readAll()).toEqual(first);
    ctx.getProviderOrder = () => ["poi-acme", "poi-overpass"];
    const reordered = await readAll();
    for (const [index, key] of reordered.entries()) expect(key).not.toBe(first[index]);
  });
});
