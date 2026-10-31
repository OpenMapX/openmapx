import type { IntegrationContext } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import type { TransitOrchestrator } from "../orchestrator.js";
import { createPlaceTransit, type PlaceTransitOptions } from "../place-transit.js";

const station: TransitStop[] = [
  { id: "mo:hbf", provider: "mo", name: "München Hbf", lat: 48.1402, lng: 11.56, modes: ["rail"] },
  {
    id: "mo:bus",
    provider: "mo",
    name: "Munich central bus station",
    lat: 48.1425,
    lng: 11.5495,
    modes: ["bus"],
  },
];

/** A board over a cache that keeps what it is given, and a stop search returning `station`. */
function setup(options: PlaceTransitOptions = {}) {
  const values = new Map<string, unknown>();
  const ctx = {
    cache: {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: unknown) => void values.set(key, value),
      withCache: async (key: string, _ttl: number, load: () => Promise<unknown>) => {
        if (values.has(key)) return values.get(key);
        const value = await load();
        values.set(key, value);
        return value;
      },
    },
  } as unknown as IntegrationContext;
  const search = vi.fn(async () => ({
    data: station,
    attributions: [],
    freshness: freshnessNow(),
  }));
  const transit = createPlaceTransit(
    ctx,
    { searchByNameRaw: search } as unknown as TransitOrchestrator,
    options,
  );
  return { transit, search, queries: () => search.mock.calls.map((call) => call[0]) };
}

const munich = {
  lat: 48.1402,
  lng: 11.56,
  name: "Munich Central Station",
  placeId: "wikidata:Q254647",
};

describe("names that link a place's stops", () => {
  it("links by the place's local name instead of its translated one", async () => {
    const lookupLocalName = vi.fn(async () => "München Hauptbahnhof");
    const { transit, queries } = setup({ lookupLocalName });
    const linked = await transit.getLinkedStops({ ...munich, osmRef: "node/2470201868" });
    expect(lookupLocalName).toHaveBeenCalledWith("node/2470201868");
    expect(queries()).toEqual(expect.arrayContaining(["München Hauptbahnhof", "München Hbf"]));
    expect(queries()).not.toContain("Munich Central Station");
    expect(linked.data.map((stop) => stop.id)).toEqual(["mo:hbf"]);
  });

  it("falls back to the shown name when the local name can't be looked up", async () => {
    const { transit, queries } = setup({
      lookupLocalName: async () => {
        throw new Error("Nominatim unavailable");
      },
    });
    await transit.getLinkedStops({ ...munich, osmRef: "node/2470201868" });
    expect(queries()).toContain("Munich Central Station");
  });

  it("ignores an OSM reference that isn't one", async () => {
    const lookupLocalName = vi.fn(async () => "x");
    const { transit } = setup({ lookupLocalName });
    await transit.getLinkedStops({ ...munich, osmRef: "node/1/../../x" });
    expect(lookupLocalName).not.toHaveBeenCalled();
  });

  it("also links by the name of the stop the place was opened for", async () => {
    const { transit, queries } = setup();
    await transit.getLinkedStops({ ...munich, name: "Bahnhof", stopName: "München Hbf" });
    expect(queries()).toEqual(expect.arrayContaining(["Bahnhof", "München Hbf"]));
  });

  it("keeps a board linked by one name from standing in for another name's", async () => {
    const { transit, search } = setup();
    await transit.getLinkedStops(munich);
    await transit.getLinkedStops(munich);
    const calls = search.mock.calls.length;
    await transit.getLinkedStops({ ...munich, name: "München Hauptbahnhof" });
    expect(search.mock.calls.length).toBeGreaterThan(calls);
  });
});
