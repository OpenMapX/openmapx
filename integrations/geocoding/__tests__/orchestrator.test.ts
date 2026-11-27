import { createHash } from "node:crypto";
import {
  effectiveProviderOrder,
  type IntegrationContext,
  type LoadedIntegration,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import type { GeocodingProvider, SearchResult } from "@openmapx/provider-kit/geocoding";
import { describe, expect, it, vi } from "vitest";
import { geocodingCacheIdentity } from "../cache-identity.js";
import { getGeocodingProvider } from "../orchestrator.js";

function result(id: string): SearchResult {
  return { id, label: id, coordinates: [0, 0], type: "poi", confidence: 1 };
}

function provider(search: SearchResult[]): GeocodingProvider {
  return {
    geocode: async () => search.map((r) => ({ ...r })),
    autocomplete: async () =>
      search.map((r) => ({ id: r.id, label: r.label, type: "poi" as const })),
    reverseGeocode: async () => (search.length ? { address: "a", city: "c" } : null),
  };
}

function ctxWith(
  integrations: Array<[string, GeocodingProvider]>,
  order: readonly string[] = ["geocoding-maptiler"],
): IntegrationContext {
  const list = integrations.map(([id, p]) => ({
    id,
    providers: new Map<string, GeocodingProvider[]>([["geocoding", [p]]]),
  }));
  return {
    config: { providerOrder: order },
    getProviderOrder: (domain: string) => (domain === "geocoding" ? order : []),
    getIntegrationsByDomain: () => list,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as IntegrationContext;
}

describe("geocoding orchestrator served-provider tagging", () => {
  it("tags single-provider results with the serving integration id", async () => {
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const results = await getGeocodingProvider(ctx).geocode("q");
    expect(results.map((r) => r.provider)).toEqual(["geocoding-maptiler"]);
  });

  it("credits the provider that actually produced results, not the first in the chain", async () => {
    const ctx = ctxWith(
      [
        ["geocoding-maptiler", provider([])], // empty → falls through
        ["geocoding-photon", provider([result("b")])],
      ],
      ["geocoding-maptiler", "geocoding-photon"],
    );
    const results = await getGeocodingProvider(ctx).geocode("q");
    expect(results).toHaveLength(1);
    expect(results[0]?.provider).toBe("geocoding-photon");
  });

  it("tags autocomplete suggestions with the serving integration id", async () => {
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const suggestions = await getGeocodingProvider(ctx).autocomplete("q");
    expect(suggestions.map((s) => s.provider)).toEqual(["geocoding-maptiler"]);
  });

  it("forwards the location bias through the fallback chain", async () => {
    const empty = provider([]);
    const served = provider([result("b")]);
    const emptySpy = vi.spyOn(empty, "autocomplete");
    const servedSpy = vi.spyOn(served, "autocomplete");
    const ctx = ctxWith(
      [
        ["geocoding-maptiler", empty],
        ["geocoding-photon", served],
      ],
      ["geocoding-maptiler", "geocoding-photon"],
    );
    const bias = { proximity: [13.4, 52.52] as [number, number], zoom: 12 };
    await getGeocodingProvider(ctx).autocomplete("coffee", "de", bias);
    expect(emptySpy).toHaveBeenCalledWith("coffee", "de", bias);
    expect(servedSpy).toHaveBeenCalledWith("coffee", "de", bias);
  });

  it("tags reverse-geocode results with the serving integration id", async () => {
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const res = await getGeocodingProvider(ctx).reverseGeocode(0, 0);
    expect(res?.provider).toBe("geocoding-maptiler");
  });

  it("asks only the selected geocoders, in order", async () => {
    const calls: string[] = [];
    const recording = (id: string, rows: SearchResult[]): GeocodingProvider => ({
      ...provider(rows),
      geocode: async () => {
        calls.push(id);
        return rows.map((r) => ({ ...r }));
      },
    });
    const ctx = ctxWith(
      [
        ["geocoding-nominatim", recording("geocoding-nominatim", [result("n")])],
        ["geocoding-acme", recording("geocoding-acme", [result("a")])],
        ["geocoding-photon", recording("geocoding-photon", [])],
      ],
      ["geocoding-photon", "geocoding-acme"],
    );
    const results = await getGeocodingProvider(ctx).geocode("q");
    expect(calls).toEqual(["geocoding-photon", "geocoding-acme"]);
    expect(results.map((r) => r.provider)).toEqual(["geocoding-acme"]);
  });

  it("accepts an installed geocoder by its integration id", async () => {
    const ctx = ctxWith([["community-geocoder", provider([result("c")])]], ["community-geocoder"]);
    const results = await getGeocodingProvider(ctx).geocode("q");
    expect(results.map((r) => r.provider)).toEqual(["community-geocoder"]);
  });

  it("skips a selected geocoder that is not loaded, warning once per reload", async () => {
    const ctx = ctxWith(
      [["geocoding-photon", provider([result("p")])]],
      ["geocoding-maptiler", "geocoding-photon"],
    );
    const results = await getGeocodingProvider(ctx).geocode("q");
    await getGeocodingProvider(ctx).autocomplete("q");
    expect(results.map((r) => r.provider)).toEqual(["geocoding-photon"]);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.log.warn).mock.calls[0]?.[0]).toContain('"geocoding-maptiler"');

    const reloaded = ctxWith(
      [["geocoding-photon", provider([result("p")])]],
      ["geocoding-maptiler", "geocoding-photon"],
    );
    await getGeocodingProvider(reloaded).geocode("q");
    expect(reloaded.log.warn).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when nothing selected is loaded", async () => {
    const ctx = ctxWith([["geocoding-photon", provider([result("p")])]], ["geocoding-maptiler"]);
    const geocode = (query: string) => getGeocodingProvider(ctx).geocode(query);
    await expect(geocode("x")).rejects.toThrow("No geocoding provider is selected and loaded");
    await expect(getGeocodingProvider(ctx).autocomplete("x")).rejects.toThrow(
      "No geocoding provider is selected and loaded",
    );
    await expect(getGeocodingProvider(ctx).reverseGeocode(0, 0)).rejects.toThrow(
      "No geocoding provider is selected and loaded",
    );
  });

  it("calls a registered provider as itself, keeping members its prototype carries", async () => {
    class PrototypeGeocoder implements GeocodingProvider {
      readonly rows = [result("proto")];
      async geocode() {
        return this.rows.map((r) => ({ ...r }));
      }
      async autocomplete() {
        return this.rows.map((r) => ({ id: r.id, label: r.label, type: "poi" as const }));
      }
      async reverseGeocode() {
        return { address: this.rows[0]?.label ?? "", city: "c" };
      }
    }
    const ctx = ctxWith([["geocoding-proto", new PrototypeGeocoder()]], ["geocoding-proto"]);
    const served = getGeocodingProvider(ctx);
    expect((await served.geocode("q")).map((r) => r.id)).toEqual(["proto"]);
    expect((await served.autocomplete("q")).map((r) => r.id)).toEqual(["proto"]);
    expect((await served.reverseGeocode(0, 0))?.address).toBe("proto");
  });
});

describe("served geocoding chain, fingerprint, admin list and cache identity", () => {
  function hostLike(order: string[]) {
    const ctx = createMockIntegrationContext({ providerOrder: { geocoding: order } });
    const integrations = ["geocoding-nominatim", "geocoding-acme", "geocoding-photon"].map(
      (id) =>
        ({
          id,
          config: {},
          providers: new Map([["geocoding", [provider([result(id)])]]]),
        }) as unknown as LoadedIntegration,
    );
    ctx.getIntegrationsByDomain = (domain) => (domain === "geocoding" ? integrations : []);
    return { ctx, integrations };
  }

  it("agree on the selected geocoders, in order", async () => {
    const { ctx, integrations } = hostLike(["geocoding-photon", "ghost", "geocoding-acme"]);
    const asked: string[] = [];
    for (const integration of integrations) {
      const [registered] = integration.providers.get("geocoding") as GeocodingProvider[];
      vi.spyOn(registered as GeocodingProvider, "geocode").mockImplementation(async () => {
        asked.push(integration.id);
        return [];
      });
    }
    await getGeocodingProvider(ctx).geocode("q");
    expect(asked).toEqual(["geocoding-photon", "geocoding-acme"]);
    expect(
      effectiveProviderOrder(ctx.getProviderOrder("geocoding"), integrations, "geocoding")
        .filter((entry) => entry.listed)
        .map((entry) => entry.integrationId),
    ).toEqual(asked);
    expect(ctx.getProviderOrderFingerprint("geocoding")).toBe(
      createHash("sha256")
        .update(JSON.stringify(asked.map((id) => [id, 0])))
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("changes the cache identity with the selected chain and keeps it for the same chain", () => {
    const first = geocodingCacheIdentity(hostLike(["geocoding-photon", "geocoding-acme"]).ctx);
    expect(geocodingCacheIdentity(hostLike(["geocoding-photon", "geocoding-acme"]).ctx)).toBe(
      first,
    );
    expect(geocodingCacheIdentity(hostLike(["geocoding-acme", "geocoding-photon"]).ctx)).not.toBe(
      first,
    );
    expect(geocodingCacheIdentity(hostLike(["geocoding-photon"]).ctx)).not.toBe(first);
  });
});

it("captures only selected backend credits before cache and does not mutate provider-owned records", async () => {
  const raw = { ...result("cached"), sourceIds: ["selected"] };
  const selected = {
    sourceId: "selected",
    name: "Captured selected",
    url: "https://selected.example",
    licensing: licensingFromDeclaration("CC0-1.0", undefined),
  };
  const sources = [selected, { ...selected, sourceId: "inactive", name: "Missing key backend" }];
  const ctx = {
    config: { providerOrder: ["geocoding-photon"] },
    getProviderOrder: () => ["geocoding-photon"],
    getIntegrationsByDomain: () => [
      {
        id: "geocoding-photon",
        manifest: { dataSources: sources },
        providers: new Map([
          [
            "geocoding",
            [
              {
                geocode: async () => [raw],
                autocomplete: async () => [],
                reverseGeocode: async () => null,
              },
            ],
          ],
        ]),
      },
    ],
  } as unknown as IntegrationContext;
  const [captured] = await getGeocodingProvider(ctx).geocode("q");
  selected.name = "Changed catalogue";
  expect(captured?.contributors?.map((receipt) => receipt.name)).toEqual(["Captured selected"]);
  expect(raw.provider).toBeUndefined();
  expect(raw.contributors).toBeUndefined();
});

it("captures geocoder metadata before the selected backend request resolves", async () => {
  let finish!: (rows: SearchResult[]) => void;
  const source = {
    sourceId: "selected",
    name: "Original acquired notice",
    url: "https://example.test",
    licensing: licensingFromDeclaration("CC0-1.0", undefined),
  };
  const selected = {
    ...provider([]),
    geocode: () =>
      new Promise<SearchResult[]>((resolve) => {
        finish = resolve;
      }),
  };
  const ctx = {
    config: { providerOrder: ["geocoding-photon"] },
    getProviderOrder: () => ["geocoding-photon"],
    getIntegrationsByDomain: () => [
      {
        id: "geocoding-photon",
        manifest: { dataSources: [source] },
        providers: new Map([["geocoding", [selected]]]),
      },
    ],
  } as unknown as IntegrationContext;
  const pending = getGeocodingProvider(ctx).geocode("q");
  source.name = "Changed catalogue";
  finish([{ ...result("row"), sourceIds: ["selected"] }]);
  expect((await pending)[0]?.contributors?.[0]?.name).toBe("Original acquired notice");
});
