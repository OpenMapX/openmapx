import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchCityBikes } from "../providers/citybikes-client.js";
import { memoryCache } from "./fixtures.js";

const bbox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };
const location = { longitude: 13.4, latitude: 52.5, city: "Berlin", country: "DE" };
const INDEX_CACHE_KEY = "shared-mobility:citybikes:networks";

function network(id: string, href: unknown) {
  return { id, name: id, href, company: ["Operator"], location };
}

function detail(id: string) {
  return {
    network: {
      id,
      name: id,
      company: ["Operator"],
      stations: [
        {
          id: "one",
          name: "Station",
          longitude: 13.4,
          latitude: 52.5,
          free_bikes: 2,
          empty_slots: 5,
        },
      ],
    },
  };
}

function stubUpstream(networks: unknown[]) {
  const http = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const body = url.search.includes("fields=")
      ? { networks }
      : detail(url.pathname.split("/").pop() ?? "");
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", http);
  return http;
}

function requestedUrls(http: ReturnType<typeof vi.fn>): string[] {
  return http.mock.calls.map(([input]) => String(input));
}

describe("CityBikes network detail links", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches only network detail paths on the CityBikes origin", async () => {
    const http = stubUpstream([
      network("at-sign", "@other.example/v2/networks/a"),
      network("dot", ".other.example/v2/networks/a"),
      network("scheme-relative", "//other.example/v2/networks/a"),
      network("absolute", "https://other.example/v2/networks/a"),
      network("query", "/v2/networks/a?x=1"),
      network("other-path", "/v2/other"),
      network("not-a-string", 42),
      network("berlin", "/v2/networks/berlin"),
    ]);

    const stations = await searchCityBikes(bbox, memoryCache());

    expect(stations.map((s) => s.sources)).toEqual([["citybikes/berlin"]]);
    const urls = requestedUrls(http);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe("https://api.citybik.es/v2/networks/berlin");
    for (const url of urls) expect(new URL(url).origin).toBe("https://api.citybik.es");
  });

  it("does not cache index entries with unusable detail links", async () => {
    stubUpstream([
      network("absolute", "https://other.example/v2/networks/a"),
      network("berlin", "/v2/networks/berlin"),
    ]);
    const cache = memoryCache();

    await searchCityBikes(bbox, cache);

    const cached = await cache.get<{ id: string }[]>(INDEX_CACHE_KEY);
    expect(cached?.map((n) => n.id)).toEqual(["berlin"]);
  });

  it("skips an unusable entry already held in the index cache", async () => {
    const http = stubUpstream([]);
    const cache = memoryCache();
    await cache.set(INDEX_CACHE_KEY, [
      network("absolute", "https://other.example/v2/networks/a"),
      network("berlin", "/v2/networks/berlin"),
    ]);

    const stations = await searchCityBikes(bbox, cache);

    expect(stations.map((s) => s.sources)).toEqual([["citybikes/berlin"]]);
    expect(requestedUrls(http)).toEqual(["https://api.citybik.es/v2/networks/berlin"]);
  });
});
