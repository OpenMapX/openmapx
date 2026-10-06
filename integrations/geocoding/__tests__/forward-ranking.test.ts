import type { IntegrationContext, SearchResult } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import snapshots from "../../geocoding-maptiler/__fixtures__/station-search.json";
import { maptilerGeocodingService, setMaptilerApiKey } from "../../geocoding-maptiler/provider.js";
import { setup } from "../index.js";
import { setConfiguredProviderList } from "../orchestrator.js";

const STATION = "maptiler:poi.14564580";
const TAXI = "maptiler:poi.25722638";
const captured: Record<string, { features: unknown[] }> = snapshots;

beforeEach(() => {
  setMaptilerApiKey("fixture-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const query = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "")
        .replace(/\.json$/, "")
        .toLowerCase();
      return new Response(JSON.stringify(captured[query] ?? { features: [] }), { status: 200 });
    }),
  );
});

afterEach(() => {
  setMaptilerApiKey(undefined);
  setConfiguredProviderList(undefined);
  vi.unstubAllGlobals();
});

function harness(cache = new Map<string, unknown>()) {
  setConfiguredProviderList("maptiler");
  const loads: string[] = [];
  const ctx = createMockIntegrationContext({
    cache: {
      withCache: async <T>(
        key: string,
        _ttl: number,
        load: (signal: AbortSignal) => Promise<T>,
      ) => {
        if (cache.has(key)) return cache.get(key) as T;
        loads.push(key);
        const value = await load(new AbortController().signal);
        cache.set(key, value);
        return value;
      },
    },
  });
  ctx.getIntegrationsByDomain = () =>
    [
      {
        id: "geocoding-maptiler",
        providers: new Map([["geocoding", [maptilerGeocodingService]]]),
      },
    ] as unknown as ReturnType<IntegrationContext["getIntegrationsByDomain"]>;
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/geocode");
  if (!route) throw new Error("geocode route missing");
  const call = async (q: string, options: Record<string, string> = {}) => {
    const send = vi.fn();
    await route.handler(
      { query: { q, ...options }, params: {}, body: undefined, headers: {} },
      {
        send,
        status: vi.fn(() => ({ send })),
        header: vi.fn(),
        type: vi.fn(),
      },
    );
    return send.mock.calls[0][0] as SearchResult[];
  };
  return { call, cache, loads };
}

describe("forward geocoding station ranking", () => {
  it.each(["Hauptbahnhof Neuss", "Hbf Neuss", "Neuss Hauptbahnhof", "Neuss Hbf"])(
    "ranks the actual railway station ahead of taxi, cafe, signal box and platforms for %s",
    async (query) => {
      const result = await harness().call(query);
      expect(result[0].id).toBe(STATION);
      expect(result.every((r) => r.provider === "geocoding-maptiler")).toBe(true);
      expect(new Set(result.map((r) => r.id)).size).toBe(result.length);
    },
  );

  it("shares a deterministic cold/warm answer regardless of the synonym that populated the cache", async () => {
    const answers: SearchResult[][] = [];
    for (const first of ["Hauptbahnhof Neuss", "Hbf Neuss"]) {
      const { call, loads } = harness();
      const cold = await call(first);
      const warm = await call(first === "Hbf Neuss" ? "Hauptbahnhof Neuss" : "Hbf Neuss");
      expect(warm).toEqual(cold);
      expect(loads).toHaveLength(1);
      expect(cold).toHaveLength(18);
      expect(cold[0].id).toBe(STATION);
      answers.push(cold);
    }
    expect(answers[0]).toEqual(answers[1]);
  });

  it("retains primary name, matched alias, and actual city context rather than administrative district matches", async () => {
    const result = await harness().call("Hauptbahnhof Düsseldorf");
    expect(result[0]).toMatchObject({
      id: "maptiler:poi.14565227",
      name: "Düsseldorf Central Station",
      aliases: ["Düsseldorf Hbf"],
      localities: ["Dusseldorf"],
      confidence: 0.8,
    });
    expect(result.find((r) => r.id === "maptiler:poi.33779531")).toMatchObject({
      localities: ["Nassenweg", "Solingen"],
      confidence: 1,
    });
    const neuss = await harness().call("Hbf Neuss");
    expect(neuss.find((r) => r.id === TAXI)).toMatchObject({
      name: "Neusser Tor",
      localities: ["Krefeld"],
      confidence: 0.89,
    });
    expect(neuss.find((r) => r.id === STATION)).toMatchObject({
      name: "Neuss Hbf",
      localities: ["Neuss"],
      confidence: 0.7,
    });
  });

  it("keeps language and proximity answers separate", async () => {
    const { call, loads } = harness();
    await call("Hbf Neuss");
    await call("Hbf Neuss", { lang: "de" });
    await call("Hbf Neuss", { lat: "51.2044", lng: "6.6847" });
    await call("Hbf Neuss", { lat: "48.14", lng: "11.58" });
    expect(loads).toHaveLength(4);
    expect(new Set(loads).size).toBe(4);
  });

  it("retains an alias found only in a later duplicate without replacing the first provider metadata", async () => {
    const bus = snapshots["hauptbahnhof neuss"].features[1];
    const station = snapshots["hbf neuss"].features[2];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const short = decodeURIComponent(new URL(url).pathname).includes("Hbf");
        const rail = {
          ...station,
          text: "Neuss Central Station",
          relevance: short ? 0.7 : 0.6,
          ...(short ? { matching_text: "Neuss Hbf" } : {}),
        };
        return new Response(JSON.stringify({ features: [bus, rail] }), { status: 200 });
      }),
    );
    const result = await harness().call("Hbf Neuss");
    expect(result[0]).toMatchObject({
      id: STATION,
      confidence: 0.6,
      provider: "geocoding-maptiler",
      aliases: ["Neuss Hbf"],
    });
    expect(result).toHaveLength(2);
  });

  it("reuses an existing unversioned forward-cache answer", async () => {
    const cachedResult: SearchResult = {
      id: TAXI,
      label: "Neusser Tor, Am Hauptbahnhof 8, 47798 Krefeld, Germany",
      coordinates: [6.567114517092705, 51.3250994384764],
      type: "poi",
      confidence: 0.89,
      rawCategory: "taxi",
      provider: "geocoding-maptiler",
    };
    const cache = new Map<string, unknown>([["cache:geocode:669e28ebd7636077", [cachedResult]]]);
    const result = await harness(cache).call("Hauptbahnhof Neuss");
    expect(result).toEqual([cachedResult]);
  });

  it("preserves provider order for an ordinary POI query whose desired candidate is absent", async () => {
    const result = await harness().call("Neuss Marktplatz");
    expect(result[0].id).toBe("maptiler:poi.32334704");
    expect(result[0].confidence).toBe(0.74);
  });

  it.each(["Taxi Neuss Hbf", "Parking Neuss Hauptbahnhof", "Am Hauptbahnhof 8 Neuss", "Berlin"])(
    "preserves provider ordering for explicit amenity, address, or ordinary queries: %s",
    async (query) => {
      const features = [
        snapshots["hauptbahnhof neuss"].features[0],
        snapshots["hbf neuss"].features[2],
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ features }), { status: 200 })),
      );
      const result = await harness().call(query);
      expect(result.map((r) => r.id)).toEqual([TAXI, STATION]);
    },
  );
});
