import { describe, expect, it } from "vitest";
import type { AutocompleteResult } from "../../types/geocoding";
import {
  compareSearchSuggestions,
  isUppercaseAcronymIntent,
  localityScore,
  mergeAutocompleteSuggestions,
  normalizeSearchTerm,
  suggestionScore,
  textMatchScore,
} from "../searchSuggestion";

const BERLIN: [number, number] = [13.405, 52.52];

describe("search suggestion primitives", () => {
  it("normalizes case, Latin diacritics, punctuation, and whitespace", () => {
    expect(normalizeSearchTerm("  MÜNCHEN—Hbf  ")).toBe("munchen hbf");
  });

  it("detects only compact uppercase acronym intent", () => {
    expect(isUppercaseAcronymIntent("UNCC")).toBe(true);
    expect(isUppercaseAcronymIntent("A1")).toBe(true);
    expect(isUppercaseAcronymIntent("uncc")).toBe(false);
    expect(isUppercaseAcronymIntent("NEW YORK")).toBe(false);
    expect(isUppercaseAcronymIntent("A")).toBe(false);
    expect(isUppercaseAcronymIntent("ABCDEFGHI")).toBe(false);
  });

  it("scores text from official codes down to provider-only matches", () => {
    const row = (label: string, sublabel?: string): AutocompleteResult => ({
      id: label,
      label,
      sublabel,
      type: "poi",
    });
    const code: AutocompleteResult = {
      ...row("Frankfurt am Main Airport"),
      searchMatch: { kind: "authoritative_code", value: "FRA", normalized: "fra" },
    };
    const alias: AutocompleteResult = {
      ...row("Frankfurt am Main Airport"),
      searchMatch: { kind: "explicit_alias", value: "Rhein-Main", normalized: "rhein main" },
    };
    const acronym: AutocompleteResult = {
      ...row("University of North Carolina at Charlotte"),
      searchMatch: { kind: "generated_acronym", value: "UNCC", normalized: "uncc" },
    };

    expect(textMatchScore(code, "FRA")).toBe(1.4);
    // Typed in lower case a code reads as a word first ("bar", "art", "spa").
    expect(textMatchScore(code, "fra")).toBe(0.9);
    expect(textMatchScore(alias, "Rhein-Main")).toBe(1.3);
    expect(textMatchScore(acronym, "uncc")).toBe(0.7);
    expect(textMatchScore(row("Café Einstein"), "cafe einstein")).toBe(1);
    expect(textMatchScore(row("Coffee Circle"), "coffee")).toBe(0.8);
    expect(textMatchScore(row("Alexanderplatz"), "alexnderplatz")).toBe(0.75);
    expect(textMatchScore(row("Berlin Coffee Lab"), "coffee")).toBe(0.7);
    expect(textMatchScore(row("Einstein", "Unter den Linden, Berlin"), "linden einstein")).toBe(
      0.5,
    );
    expect(textMatchScore(row("Palmers Brewery"), "rewe")).toBe(0.3);
    expect(textMatchScore(row("Alexanderplatz"), "alxndrplatz")).toBe(0.15);
    expect(textMatchScore(row("King's Cross"), "kings cross")).toBe(1);
    expect(textMatchScore(row("Anything"), "")).toBe(0);
  });

  it("reads one name the ways people write it", () => {
    const row = (label: string, sublabel?: string): AutocompleteResult => ({
      id: label,
      label,
      sublabel,
      type: "poi",
    });
    expect(textMatchScore(row("Friedrichstrasse 100"), "friedrichstraße 100")).toBe(1);
    expect(textMatchScore(row("Friedrichstraße 100"), "friedrichstr 100")).toBe(1);
    expect(textMatchScore(row("Aachen Hauptbahnhof", "Bahnhofplatz, Aachen"), "aachen hbf")).toBe(
      1,
    );
    // Said in its own town, a station drops the town's name.
    expect(textMatchScore(row("Aachen Hauptbahnhof", "Bahnhofplatz, Aachen"), "hbf")).toBe(1);
    expect(
      textMatchScore(row("New York Bagel Bar", "New York Bagel Bar, Berlin"), "york bagel bar"),
    ).toBe(0.7);
    // The name, then where it is.
    expect(textMatchScore(row("10115", "10115, Berlin, Germany"), "10115 berlin")).toBe(1);
    expect(textMatchScore(row("Einstein", "Unter den Linden, Berlin"), "einstein linden")).toBe(1);
  });

  it("allows one slip in a longer word but not in a short one", () => {
    const row = (label: string): AutocompleteResult => ({ id: label, label, type: "poi" });
    expect(textMatchScore(row("Potsdamer Platz"), "potsdamer plaz")).toBe(0.75);
    expect(textMatchScore(row("Brandenburger Tor"), "brandenbrger tor")).toBe(0.75);
    expect(textMatchScore(row("Band"), "bank")).toBe(0.15);
    expect(textMatchScore(row("Potsdamer Platz"), "potsdamr plaz")).toBe(0.75);
  });

  it("takes a place's fame at face value, and half of it for a name only partly typed", () => {
    const context = { query: "louvre", proximity: BERLIN, zoom: 14 };
    const bar: AutocompleteResult = {
      id: "bar",
      label: "Louvre",
      type: "poi",
      coordinates: [13.36, 52.5],
    };
    const museum: AutocompleteResult = {
      id: "museum",
      label: "Louvre",
      type: "poi",
      coordinates: [2.336, 48.861],
      fame: 0.89,
    };
    // Four kilometres away and named exactly, the bar still loses to the museum in Paris.
    expect(suggestionScore(museum, context)).toBeGreaterThan(suggestionScore(bar, context));

    const paris: AutocompleteResult = {
      id: "paris",
      label: "Paris",
      type: "region",
      rawCategory: "place/city",
      coordinates: [2.35, 48.86],
    };
    const square: AutocompleteResult = {
      id: "square",
      label: "Pariser Platz",
      type: "poi",
      coordinates: [13.379, 52.516],
      fame: 0.55,
    };
    const parisQuery = { query: "paris", proximity: BERLIN, zoom: 14 };
    expect(suggestionScore(paris, parisQuery)).toBeGreaterThan(suggestionScore(square, parisQuery));
  });

  it("keeps the fame either of two merged rows knew", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        { id: "photon", label: "Eiffel Tower", type: "poi", coordinates: [2.2945, 48.8584] },
        {
          id: "wikidata:Q243",
          label: "Eiffel Tower",
          type: "poi",
          coordinates: [2.2944, 48.8583],
          ids: { wikidata: "Q243" },
          fame: 0.91,
        },
      ],
      { query: "eiffel tower", proximity: BERLIN, zoom: 14 },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ fame: 0.91, ids: { wikidata: "Q243" } });
  });

  it("gives an area fame by its rank, and a meadow or peak none", () => {
    const area = (label: string, rawCategory: string): AutocompleteResult => ({
      id: label,
      label,
      rawCategory,
      type: "region",
      coordinates: [2.35, 48.86],
    });
    const far = { query: "x", proximity: BERLIN, zoom: 14 };
    const score = (row: AutocompleteResult) => suggestionScore(row, { ...far, query: row.label });
    expect(score(area("Paris", "place/city"))).toBeGreaterThan(
      score(area("Paris", "place/square")),
    );
    expect(score(area("Paris", "place/square"))).toBeGreaterThan(
      score(area("Paris", "natural/peak")),
    );
    expect(score(area("Paris", "boundary/administrative"))).toBeGreaterThan(
      score(area("Paris", "landuse/grass")),
    );
  });

  it("keeps a famous area ahead of a nearby same-named village at country zoom", () => {
    const city: AutocompleteResult = {
      id: "frankfurt-main",
      label: "Frankfurt am Main",
      coordinates: [8.68, 50.11],
      type: "region",
      rawCategory: "place/city",
    };
    const village: AutocompleteResult = {
      id: "frankfurt-village",
      label: "Frankfurt",
      coordinates: [12.55, 52.0],
      type: "region",
      rawCategory: "place/village",
    };
    const context = { query: "frankfurt", proximity: [10.45, 51.16] as [number, number], zoom: 6 };
    expect(compareSearchSuggestions(city, village, context)).toBeLessThan(0);
  });

  it("lets nearby credit fade with distance faster the further the map is zoomed in", () => {
    const cafe: AutocompleteResult = {
      id: "cafe",
      label: "Coffee Circle",
      coordinates: [13.405, 52.565],
      type: "poi",
    };
    const city = localityScore(cafe, { query: "coffee", proximity: BERLIN, zoom: 16 });
    const region = localityScore(cafe, { query: "coffee", proximity: BERLIN, zoom: 10 });
    expect(city).toBeLessThan(region);
    expect(localityScore(cafe, { query: "coffee" })).toBe(0);
  });

  it("ranks nearby cafés above a far county that shares the typed name", () => {
    const county: AutocompleteResult = {
      id: "coffee-county",
      label: "Coffee",
      coordinates: [-86.07, 35.49],
      type: "region",
      rawCategory: "place/county",
    };
    const cafe: AutocompleteResult = {
      id: "coffee-circle",
      label: "Coffee Circle",
      coordinates: [13.39, 52.53],
      type: "poi",
    };
    const context = { query: "coffee", proximity: BERLIN, zoom: 14 };
    expect(compareSearchSuggestions(cafe, county, context)).toBeLessThan(0);
  });

  it("keeps a far prominent place of the exact name ahead of a nearby partial match", () => {
    const paris: AutocompleteResult = {
      id: "paris",
      label: "Paris",
      coordinates: [2.35, 48.86],
      type: "region",
      rawCategory: "place/city",
    };
    const parisBar: AutocompleteResult = {
      id: "paris-bar",
      label: "Paris Bar",
      coordinates: [13.32, 52.5],
      type: "poi",
    };
    for (const zoom of [8, 12, 16]) {
      const context = { query: "paris", proximity: parisBar.coordinates, zoom };
      expect(compareSearchSuggestions(paris, parisBar, context)).toBeLessThan(0);
    }
  });

  it("puts the nearby square ahead of far places of the same name", () => {
    const berlin: AutocompleteResult = {
      id: "berlin",
      label: "Alexanderplatz",
      coordinates: [13.413, 52.522],
      type: "transit_stop",
      importance: 0.7,
    };
    const elsewhere: AutocompleteResult = {
      id: "hoehr",
      label: "Alexanderplatz",
      coordinates: [7.66, 50.43],
      type: "region",
      rawCategory: "place/square",
    };
    const context = { query: "alexanderplatz", proximity: BERLIN, zoom: 14 };
    expect(compareSearchSuggestions(berlin, elsewhere, context)).toBeLessThan(0);
  });

  it("scores chains by whether they operate in the map's country", () => {
    const chain = (brandPresence: AutocompleteResult["brandPresence"]): AutocompleteResult => ({
      id: `chain-${brandPresence}`,
      label: "Coffee Fellows",
      type: "brand",
      brandPresence,
    });
    const context = { query: "coffee fellows" };
    expect(suggestionScore(chain("here"), context)).toBeGreaterThan(
      suggestionScore(chain("unknown"), context),
    );
    expect(suggestionScore(chain("unknown"), context)).toBeGreaterThan(
      suggestionScore(chain("elsewhere"), context),
    );
  });

  it("keeps match evidence and exact text ahead of local preference", () => {
    const exact: AutocompleteResult = {
      id: "exact",
      label: "Frankfurt Airport",
      coordinates: [9, 51],
      type: "poi",
      searchMatch: { kind: "explicit_alias", value: "FRA", normalized: "fra" },
      importance: 0.5,
    };
    const prefix: AutocompleteResult = {
      id: "prefix",
      label: "Fraser",
      coordinates: [8.5, 50],
      type: "poi",
      searchMatch: { kind: "explicit_alias", value: "Fraser", normalized: "fraser" },
      importance: 1,
    };
    const context = { query: "FRA", proximity: [8.5, 50] as [number, number] };
    expect(compareSearchSuggestions(exact, prefix, context)).toBeLessThan(0);

    const important = { ...exact, id: "important", importance: 0.9 };
    expect(compareSearchSuggestions(important, exact, context)).toBeLessThan(0);

    const nearby = { ...exact, id: "nearby", coordinates: [8.5, 50] as [number, number] };
    expect(compareSearchSuggestions(nearby, exact, context)).toBeLessThan(0);
  });

  it("promotes a nearby equally matching place over a more prominent distant one", () => {
    const distant: AutocompleteResult = {
      id: "distant",
      label: "Central Cafe",
      coordinates: [-80, 35],
      type: "poi",
      importance: 0.9,
    };
    const nearby: AutocompleteResult = {
      ...distant,
      id: "nearby",
      coordinates: [6.084, 50.775],
      importance: 0.3,
    };

    expect(
      compareSearchSuggestions(nearby, distant, {
        query: "Central Cafe",
        proximity: [6.084, 50.775],
      }),
    ).toBeLessThan(0);
    expect(compareSearchSuggestions(distant, nearby, { query: "Central Cafe" })).toBeLessThan(0);
  });

  it("keeps a closer exact destination ahead when neither is near", () => {
    const france: AutocompleteResult = {
      id: "z-france",
      label: "Paris",
      coordinates: [2.348, 48.853],
      type: "region",
    };
    const texas: AutocompleteResult = {
      id: "a-texas",
      label: "Paris",
      coordinates: [-95.555, 33.662],
      type: "region",
    };

    expect(
      compareSearchSuggestions(france, texas, { query: "Paris", proximity: [6.084, 50.775] }),
    ).toBeLessThan(0);
  });

  it("deduplicates a geocoder and catalog result without losing the stronger match", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        {
          id: "geo:fra",
          label: "Frankfurt am Main Airport",
          coordinates: [8.57, 50.03],
          type: "poi",
          provider: "geocoder",
        },
        {
          id: "oa:EDDF",
          label: "Frankfurt am Main Airport",
          coordinates: [8.5701, 50.0301],
          type: "poi",
          ids: { icao: "EDDF", iata: "FRA" },
          searchMatch: { kind: "authoritative_code", value: "FRA", normalized: "fra" },
          importance: 0.9,
          provider: "knowledge-ourairports",
        },
      ],
      { query: "FRA" },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "oa:EDDF",
      ids: { icao: "EDDF", iata: "FRA" },
      searchMatch: { kind: "authoritative_code" },
      contributingProviders: ["knowledge-ourairports", "geocoder"],
    });
  });

  it("joins a famous city's Wikidata row to a geocoder's row kilometres away, keeping the name it matched", () => {
    const tokyo = mergeAutocompleteSuggestions(
      [
        {
          id: "osm:relation/1543125",
          label: "Tokyo",
          coordinates: [139.7639, 35.6769],
          type: "region",
          rawCategory: "place/city",
          provider: "geocoding-photon",
        },
        {
          id: "wikidata:Q1490",
          ids: { wikidata: "Q1490" },
          label: "Tokyo",
          coordinates: [139.6922, 35.6897],
          type: "region",
          rawCategory: "place/city",
          searchMatch: { kind: "name", value: "Tōkyō", normalized: "tokyo" },
          fame: 1,
          provider: "search-notable-places",
        },
      ],
      { query: "tokyo" },
    );
    expect(tokyo).toHaveLength(1);
    expect(tokyo[0]).toMatchObject({ fame: 1, ids: { wikidata: "Q1490" } });

    const rome = mergeAutocompleteSuggestions(
      [
        {
          id: "osm:relation/41485",
          label: "Rome",
          coordinates: [12.4829, 41.8933],
          type: "region",
          rawCategory: "place/city",
          importance: 0.9,
        },
        {
          id: "wikidata:Q220",
          ids: { wikidata: "Q220" },
          label: "Rome",
          coordinates: [12.4828, 41.8931],
          type: "region",
          rawCategory: "place/city",
          searchMatch: { kind: "name", value: "Rom", normalized: "rom" },
          fame: 1,
        },
      ],
      { query: "rom" },
    );
    expect(rome).toHaveLength(1);
    expect(rome[0].searchMatch).toMatchObject({ normalized: "rom" });
    expect(textMatchScore(rome[0], "rom")).toBe(1);
  });

  it("keeps two villages of one name a few kilometres apart", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        { id: "osm:a", label: "Neuenkirchen", coordinates: [8.0, 52.0], type: "region" },
        { id: "osm:b", label: "Neuenkirchen", coordinates: [8.05, 52.03], type: "region" },
      ],
      { query: "neuenkirchen" },
    );
    expect(merged).toHaveLength(2);
  });

  it("deduplicates shared external identities and unions identifiers and providers", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        {
          id: "transit:one",
          label: "Berlin Hauptbahnhof",
          coordinates: [13.369, 52.525],
          type: "transit_stop",
          ids: { uic: "8011160", transit: "one" },
          provider: "transit",
          contributingProviders: ["transit", "db"],
        },
        {
          id: "osm:node/123",
          label: "Berlin Hauptbahnhof",
          coordinates: [13.37, 52.526],
          type: "poi",
          ids: { uic: "8011160", osm: "node/123" },
          searchMatch: { kind: "explicit_reference", value: "8011160", normalized: "8011160" },
          importance: 0.8,
          provider: "search-osm-aliases",
        },
      ],
      { query: "8011160" },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].ids).toEqual({ uic: "8011160", osm: "node/123", transit: "one" });
    expect(merged[0].contributingProviders).toEqual(["search-osm-aliases", "transit", "db"]);
  });

  it("measures same-place distance geodesically so high latitudes are not penalised", () => {
    // 0.015° of longitude at 60°N is roughly 830 m: the same station seen by two sources.
    const merged = mergeAutocompleteSuggestions(
      [
        {
          id: "nsr:StopPlace:337",
          label: "Oslo S",
          coordinates: [10.75, 59.911],
          type: "transit_stop",
          provider: "geocoding-entur",
        },
        {
          id: "osm:node/1",
          label: "Oslo S",
          coordinates: [10.765, 59.911],
          type: "poi",
          provider: "geocoder",
        },
      ],
      { query: "oslo" },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].contributingProviders).toEqual(["geocoding-entur", "geocoder"]);
  });

  it("keeps a station apart from the same-named square it serves", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        {
          id: "square",
          label: "Alexanderplatz",
          coordinates: [13.4133, 52.5219],
          type: "region",
          rawCategory: "place/square",
        },
        {
          id: "station",
          label: "Alexanderplatz",
          coordinates: [13.4114, 52.5215],
          type: "poi",
          rawCategory: "railway/station",
        },
        {
          id: "stop",
          label: "Alexanderplatz",
          coordinates: [13.4118, 52.5217],
          type: "poi",
          rawCategory: "highway/bus_stop",
        },
      ],
      { query: "alexanderplatz" },
    );
    expect(merged.map((row) => row.id).sort()).toEqual(["square", "station"]);
  });

  it("keeps same-named places apart beyond a kilometre", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        { id: "one", label: "Bahnhofstraße", coordinates: [7, 50], type: "street" },
        { id: "two", label: "Bahnhofstraße", coordinates: [7.02, 50], type: "street" },
      ],
      { query: "bahnhof" },
    );
    expect(merged).toHaveLength(2);
  });

  it("does not coordinate-deduplicate different canonical labels", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        { id: "one", label: "Central Hotel", coordinates: [7, 50], type: "poi" },
        { id: "two", label: "Central Station", coordinates: [7, 50], type: "poi" },
      ],
      { query: "central" },
    );
    expect(merged).toHaveLength(2);
  });
});
