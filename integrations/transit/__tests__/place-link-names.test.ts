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
function setup(options: PlaceTransitOptions = {}, stops: TransitStop[] = station) {
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
    data: stops,
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

/** A stop `meters` north of (lat, lng): 0.001° of latitude is about 111 m. */
function stopAt(id: string, name: string, lat: number, lng: number, meters = 100): TransitStop {
  return { id, provider: id.split(":")[0], name, lat: lat + meters / 111_000, lng, modes: ["bus"] };
}

async function linkedNames(place: { lat: number; lng: number; name: string }, names: string[]) {
  const stops = names.map((name, i) => stopAt(`p:${i}`, name, place.lat, place.lng));
  const { transit } = setup({}, stops);
  const linked = await transit.getLinkedStops(place);
  return linked.data.map((stop) => stop.name);
}

describe("which stops a place's name links", () => {
  // Names live providers give stops within 1 km of Köln Messe/Deutz.
  const deutz = { lat: 50.940833, lng: 6.975, name: "Köln Messe/Deutz" };

  it("links the station under each source's spelling", async () => {
    const station = [
      "Köln Messe/Deutz",
      "Köln Messe/Deutz Bf",
      "Köln Messe/Deutz Bahnhof",
      "Messe/Deutz Bahnhof, Köln",
      "Messe/Deutz",
      "Köln Messe/Deutz Gl. 11-12",
    ];
    expect(await linkedNames(deutz, station)).toEqual(station);
  });

  it("links a stop named as the station's own", async () => {
    const own = ["Köln Bf Deutz/Messe LANXESS arena", "Köln, Deutz Bf Deutz/Messe LANXESS arena"];
    expect(await linkedNames(deutz, own)).toEqual(own);
  });

  it("doesn't link stops that only share the district or the town", async () => {
    const others = [
      "Köln Deutz Suevenstr.",
      "Köln, Deutz Gummersbacher Straße",
      "Köln, Deutz Deutzer Freiheit",
      "Köln Deutz Technische Hochschule",
      "Köln Deutz Koelnmesse",
      "Köln Bf Deutz/Messeplatz",
      "KÖLN",
    ];
    expect(await linkedNames(deutz, others)).toEqual([]);
  });

  it("links a stop named with or without its town", async () => {
    const neumarkt = { lat: 50.9364, lng: 6.9469, name: "Neumarkt" };
    expect(
      await linkedNames(neumarkt, ["Köln Neumarkt", "Neumarkt", "Köln Neumarkt Galerie"]),
    ).toEqual(["Köln Neumarkt", "Neumarkt"]);
    const friedrichstrasse = { lat: 52.5203, lng: 13.3869, name: "Berlin Friedrichstraße" };
    expect(
      await linkedNames(friedrichstrasse, [
        "S+U Friedrichstr. Bhf (Berlin)",
        "Friedrichstr./Reinhardtstr. (Berlin)",
      ]),
    ).toEqual(["S+U Friedrichstr. Bhf (Berlin)"]);
  });

  it("links a stop whose town a comma sets apart, but not another stop of that district", async () => {
    const pasing = { lat: 48.1497, lng: 11.4614, name: "München-Pasing" };
    expect(
      await linkedNames(pasing, [
        "Pasing, München",
        "Pasing Bahnhof, München",
        "Krankenhaus Pasing, München",
        "Rathaus Pasing, München",
      ]),
    ).toEqual(["Pasing, München", "Pasing Bahnhof, München"]);
    const marienplatz = { lat: 48.1372, lng: 11.5755, name: "Marienplatz" };
    expect(await linkedNames(marienplatz, ["Marienplatz, München"])).toEqual([
      "Marienplatz, München",
    ]);
  });

  it("links a station named for its side of town", async () => {
    const ost = { lat: 48.1274, lng: 11.6047, name: "München Ost" };
    expect(
      await linkedNames(ost, [
        "Ostbahnhof, München",
        "München Ostbahnhof (Orleansplatz)",
        "München Ostfriedhof",
      ]),
    ).toEqual(["Ostbahnhof, München", "München Ostbahnhof (Orleansplatz)"]);
  });

  it("links the stops a main station's name marks as its own", async () => {
    const hbf = { lat: 50.9432, lng: 6.9586, name: "Köln Hauptbahnhof" };
    expect(
      await linkedNames(hbf, ["Köln Hbf", "Köln Dom/Hbf", "Köln Breslauer Platz/Hbf", "Köln Dom"]),
    ).toEqual(["Köln Hbf", "Köln Dom/Hbf", "Köln Breslauer Platz/Hbf"]);
    const alex = { lat: 52.5219, lng: 13.4132, name: "Berlin Alexanderplatz" };
    expect(
      await linkedNames(alex, [
        "S+U Alexanderplatz Bhf/Gontardstr. (Berlin)",
        "U Alexanderplatz/Karl-Liebknecht-Str. (Berlin)",
      ]),
    ).toEqual(["S+U Alexanderplatz Bhf/Gontardstr. (Berlin)"]);
  });

  it("links only the station of a place named like its town", async () => {
    const homburg = { lat: 50.2193, lng: 8.6211, name: "Bad Homburg" };
    expect(
      await linkedNames(homburg, ["Bad Homburg Bahnhof", "Bad Homburg Kurhaus", "Bad Homburg"]),
    ).toEqual(["Bad Homburg Bahnhof", "Bad Homburg"]);
  });

  it("doesn't read a comma as setting the town apart when the place is a town", async () => {
    const bruehl = { lat: 50.8285, lng: 6.9036, name: "Brühl" };
    expect(
      await linkedNames(bruehl, [
        "Brühl Bf",
        "Brühl Mitte",
        "Brühl Nord",
        "Brühl Am Stern",
        "Brühl, Giesler Galerie",
        "Rathaus, Brühl",
      ]),
    ).toEqual(["Brühl Bf"]);
  });

  it("keeps different places with a shared last word apart", async () => {
    const tor = { lat: 52.4991, lng: 13.4181, name: "Kottbusser Tor" };
    expect(await linkedNames(tor, ["U Kottbusser Tor (Berlin)", "Schlesisches Tor"])).toEqual([
      "U Kottbusser Tor (Berlin)",
    ]);
  });

  it("doesn't link a stop more than 1 km away", async () => {
    const stops = [stopAt("p:far", "Köln Messe/Deutz", deutz.lat, deutz.lng, 1_200)];
    const { transit } = setup({}, stops);
    expect((await transit.getLinkedStops(deutz)).data).toEqual([]);
  });
});
