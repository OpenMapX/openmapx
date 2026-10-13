import type { CacheClient } from "@openmapx/mobility-core/cache";
import { afterEach, expect, it, vi } from "vitest";
import { searchCityBikes } from "../providers/citybikes-client.js";
import { searchNextbike } from "../providers/nextbike-client.js";

function memoryCache(): CacheClient {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (values.get(key) as T) ?? null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    del: async (key) => {
      values.delete(key);
    },
    withCache: async function <T>(
      key: string,
      _ttl: number,
      load: (signal: AbortSignal) => Promise<T>,
    ) {
      const previous = await this.get<T>(key);
      if (previous !== null) return previous;
      const data = await load(new AbortController().signal);
      await this.set(key, data);
      return data;
    },
  };
}
const bbox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };
afterEach(() => vi.unstubAllGlobals());

it("captures explicit CityBikes parent credit before caching native network records", async () => {
  const cache = memoryCache();
  const receipt = {
    sourceId: "citybikes",
    name: "CityBikes",
    attributionText: "Original city credit",
  };
  const http = vi.fn(
    async (input: unknown) =>
      new Response(
        JSON.stringify(
          String(input).includes("?fields=")
            ? {
                networks: [
                  {
                    id: "berlin",
                    name: "Berlin",
                    href: "/v2/networks/berlin",
                    company: ["Operator"],
                    location: { longitude: 13.4, latitude: 52.5, city: "Berlin", country: "DE" },
                  },
                ],
              }
            : {
                network: {
                  id: "berlin",
                  name: "Berlin",
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
              },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", http);
  const first = await searchCityBikes(bbox, cache, [receipt]);
  expect(first[0].sources).toEqual(["citybikes/berlin"]);
  expect(first[0].contributors).toEqual([receipt]);
  const retained = await searchCityBikes({ ...bbox, east: 13.45 }, cache, [
    { ...receipt, attributionText: "Changed registry" },
  ]);
  expect(retained[0].contributors).toEqual([receipt]);
  expect(http).toHaveBeenCalledTimes(2);
});
it("captures explicit Nextbike parent credit with the cached acquisition before bbox mapping", async () => {
  const cache = memoryCache();
  const receipt = {
    sourceId: "nextbike",
    name: "Nextbike",
    attributionText: "Original Nextbike credit",
  };
  const http = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          countries: [
            {
              country: "DE",
              country_name: "Germany",
              cities: [
                {
                  uid: 1,
                  name: "Berlin",
                  lat: 52.5,
                  lng: 13.4,
                  places: [
                    {
                      uid: 2,
                      name: "Station",
                      lat: 52.5,
                      lng: 13.4,
                      bikes: 2,
                      bike_racks: 5,
                      free_racks: 3,
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", http);
  const first = await searchNextbike(bbox, cache, [receipt]);
  expect(first[0].contributors).toEqual([receipt]);
  const retained = await searchNextbike({ ...bbox, east: 13.45 }, cache, [
    { ...receipt, attributionText: "Changed registry" },
  ]);
  expect(retained[0].contributors).toEqual([receipt]);
  expect(http).toHaveBeenCalledTimes(1);
});
