import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maptilerGeocodingService, resolveMaptilerApiKey, setMaptilerApiKey } from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setMaptilerApiKey("test-key");
});

afterEach(() => {
  setMaptilerApiKey(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MapTiler geocoding provider", () => {
  it("maps geocode features with maptiler: ids, place-type and rawCategory", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            id: "poi.123",
            text: "Köln Hauptbahnhof",
            place_name: "Köln Hauptbahnhof, Köln, Germany",
            place_type: ["poi"],
            relevance: 1,
            geometry: { coordinates: [6.9582814, 50.9430759] },
            properties: { categories: ["railway_station", "transport"] },
          },
          {
            id: "address.456",
            text: "Bahnhofsvorplatz 1",
            place_name: "Bahnhofsvorplatz 1, Köln, Germany",
            place_type: ["address"],
            relevance: 0.9,
            geometry: { coordinates: [6.96, 50.94] },
          },
          {
            id: "street.789",
            text: "Domkloster",
            place_name: "Domkloster, Köln, Germany",
            place_type: ["street"],
            relevance: 0.8,
            geometry: { coordinates: [6.95, 50.94] },
          },
          {
            id: "place.10",
            text: "Köln",
            place_name: "Köln, Germany",
            place_type: ["municipality"],
            relevance: 0.7,
            geometry: { coordinates: [6.95, 50.93] },
          },
        ],
      }),
    );

    const results = await maptilerGeocodingService.geocode("Köln Hbf", "de");

    expect(results).toEqual([
      {
        id: "maptiler:poi.123",
        addressEvidence: {
          components: {},
          source: "geocoding-maptiler",
          method: "provider-label",
          recordId: "maptiler:poi.123",
        },
        label: "Köln Hauptbahnhof, Köln, Germany",
        name: "Köln Hauptbahnhof",
        coordinates: [6.9582814, 50.9430759],
        type: "poi",
        confidence: 1,
        rawCategory: "railway_station",
      },
      {
        id: "maptiler:address.456",
        addressEvidence: {
          components: {},
          source: "geocoding-maptiler",
          method: "provider-label",
          recordId: "maptiler:address.456",
        },
        label: "Bahnhofsvorplatz 1, Köln, Germany",
        name: "Bahnhofsvorplatz 1",
        coordinates: [6.96, 50.94],
        type: "address",
        confidence: 0.9,
        rawCategory: undefined,
      },
      {
        id: "maptiler:street.789",
        addressEvidence: {
          components: {},
          source: "geocoding-maptiler",
          method: "provider-label",
          recordId: "maptiler:street.789",
        },
        label: "Domkloster, Köln, Germany",
        name: "Domkloster",
        coordinates: [6.95, 50.94],
        type: "street",
        confidence: 0.8,
        rawCategory: undefined,
      },
      {
        id: "maptiler:place.10",
        addressEvidence: {
          components: {},
          source: "geocoding-maptiler",
          method: "provider-label",
          recordId: "maptiler:place.10",
        },
        label: "Köln, Germany",
        name: "Köln",
        coordinates: [6.95, 50.93],
        type: "region",
        confidence: 0.7,
        rawCategory: undefined,
      },
    ]);
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/geocoding/K%C3%B6ln%20Hbf.json");
    expect(url).toContain("key=test-key");
    expect(url).toContain("types=");
  });

  it.each([
    ["osm:n123", "node/123"],
    ["osm:w456", "way/456"],
    ["osm:r9007199254740993", "relation/9007199254740993"],
  ])("preserves the root reference %s without rounding its ID", async (ref, osmRef) => {
    const feature = {
      id: "poi.123",
      text: "Cafe",
      place_name: "Cafe, Berlin",
      place_type: ["poi"],
      relevance: 1,
      geometry: { coordinates: [13.4, 52.5] },
      properties: { ref, wikidata: "Q123" },
      context: [{ id: "municipality.1", text: "Berlin", ref: "osm:r999" }],
    };
    mockFetch.mockImplementation(async () => mockOk({ features: [feature] }));
    for (const result of [
      ...(await maptilerGeocodingService.geocode("Cafe")),
      ...(await maptilerGeocodingService.autocomplete("Cafe")),
    ]) {
      expect(result.ids).toEqual({ osm: osmRef, wikidata: "Q123" });
      expect(result.directOsmReference).toEqual({
        source: "geocoding-maptiler",
        recordId: "maptiler:poi.123",
        osmRef,
      });
    }
  });

  it.each([
    undefined,
    null,
    123,
    "osm:w0",
    "osm:w012",
    "osm:w-1",
    "osm:w1.2",
    "osm:w1e3",
    "osm:w12junk",
    "osm:w12\n",
    " osm:w12",
    "osm:W12",
    "way/12",
    "osm:x12",
  ])("rejects malformed root reference %s and ignores context references", async (ref) => {
    mockFetch.mockImplementation(async () =>
      mockOk({
        features: [
          {
            id: "poi.123",
            text: "Cafe",
            place_name: "Cafe",
            place_type: ["poi"],
            relevance: 1,
            geometry: { coordinates: [13.4, 52.5] },
            properties: { ref },
            context: [{ id: "municipality.1", text: "Berlin", ref: "osm:r999" }],
          },
        ],
      }),
    );
    for (const result of [
      ...(await maptilerGeocodingService.geocode("Cafe")),
      ...(await maptilerGeocodingService.autocomplete("Cafe")),
    ]) {
      expect(result.ids?.osm).toBeUndefined();
      expect(result.directOsmReference).toBeUndefined();
    }
  });

  it("preserves available address tags and context without parsing label numbers", async () => {
    mockFetch.mockImplementation(async () =>
      mockOk({
        features: [
          {
            id: "poi.123",
            text: "Cafe 99",
            place_name: "Cafe 99, Wrong road 88, 99999 Berlin",
            place_type: ["poi"],
            relevance: 1,
            geometry: { coordinates: [13.4, 52.5] },
            properties: {
              country_code: "de",
              feature_tags: {
                "addr:street": "  Main road  ",
                "addr:housenumber": " 20a ",
                "addr:place": "Square",
                "addr:full": "Main road 20a",
                "addr:postcode": "10179",
                "addr:city": "Berlin",
                "addr:state": 4,
                "addr:country": "",
                name: "Cafe 99",
              },
            },
            context: [
              { id: "municipality.1", text: "Berlin" },
              { id: "region.1", text: "Berlin state" },
              { id: "country.1", text: "Germany", country_code: "de" },
            ],
          },
        ],
      }),
    );
    const components = {
      house_number: "20a",
      road: "Main road",
      place: "Square",
      full: "Main road 20a",
      postcode: "10179",
      city: "Berlin",
      municipality: "Berlin",
      state: "Berlin state",
      country: "Germany",
      country_code: "de",
    };
    for (const result of [
      ...(await maptilerGeocodingService.geocode("Cafe")),
      ...(await maptilerGeocodingService.autocomplete("Cafe")),
    ]) {
      expect(result.addressEvidence).toEqual({
        components,
        source: "geocoding-maptiler",
        method: "provider-address",
        recordId: "maptiler:poi.123",
      });
    }
    expect((await maptilerGeocodingService.reverseGeocode(52.5, 13.4))?.addressEvidence).toEqual({
      components,
      source: "geocoding-maptiler",
      method: "reverse",
      recordId: "maptiler:poi.123",
    });
  });

  it("identifies explicit root address tags as OSM evidence only with a valid root reference", async () => {
    mockFetch.mockImplementation(async () =>
      mockOk({
        features: [
          {
            id: "poi.123",
            text: "Cafe",
            place_name: "Cafe, Wrong road 88, Berlin",
            place_type: ["poi"],
            relevance: 1,
            geometry: { coordinates: [13.4, 52.5] },
            properties: {
              ref: "osm:w123",
              feature_tags: { "addr:street": "Main road", "addr:housenumber": "20a" },
            },
            context: [{ id: "municipality.1", text: "Berlin" }],
          },
        ],
      }),
    );
    for (const result of [
      ...(await maptilerGeocodingService.geocode("Cafe")),
      ...(await maptilerGeocodingService.autocomplete("Cafe")),
    ]) {
      expect(result.addressEvidence).toEqual({
        components: { road: "Main road", house_number: "20a" },
        source: "geocoding-maptiler",
        method: "osm-tags",
        recordId: "osm:way/123",
      });
      expect(result.address).toBe("Main road 20a");
    }
  });

  it.each([
    [{ "addr:country": "DE" }, { country_code: "de" }],
    [
      { "addr:city": "Berlin", "addr:postcode": "10179" },
      { city: "Berlin", postcode: "10179" },
    ],
  ])(
    "retains the display address fallback when root tags contain only locality context %j",
    async (tags, components) => {
      mockFetch.mockImplementation(async () =>
        mockOk({
          features: [
            {
              id: "poi.123",
              text: "Cafe",
              place_name: "Cafe, Main road 20, Berlin",
              place_type: ["poi"],
              relevance: 1,
              geometry: { coordinates: [13.4, 52.5] },
              properties: { ref: "osm:w123", feature_tags: tags },
            },
          ],
        }),
      );
      const [forward] = await maptilerGeocodingService.geocode("Cafe");
      const [autocomplete] = await maptilerGeocodingService.autocomplete("Cafe");
      for (const result of [forward, autocomplete]) {
        expect(result.address).toBeUndefined();
        expect(result.addressEvidence).toEqual({
          components,
          source: "geocoding-maptiler",
          method: "provider-address",
          recordId: "maptiler:poi.123",
        });
        expect(result.directOsmReference).toEqual({
          source: "geocoding-maptiler",
          recordId: "maptiler:poi.123",
          osmRef: "way/123",
        });
        expect(result.ids?.osm).toBe("way/123");
      }
      // These original labels remain the selection address if exact details are unavailable.
      expect(forward.label).toBe("Cafe, Main road 20, Berlin");
      expect(autocomplete.sublabel).toBe("Cafe, Main road 20, Berlin");
    },
  );

  it("marks a display label as label-only evidence without inventing components", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            id: "poi.123",
            text: "Cafe 99",
            place_name: "Cafe 99, Main road 88, 10179 Berlin",
            place_type: ["poi"],
            relevance: 1,
            geometry: { coordinates: [13.4, 52.5] },
          },
        ],
      }),
    );
    const [result] = await maptilerGeocodingService.autocomplete("Cafe");
    expect(result.addressEvidence).toEqual({
      components: {},
      source: "geocoding-maptiler",
      method: "provider-label",
      recordId: "maptiler:poi.123",
    });
  });

  it("maps neighbourhood place-type to street", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            id: "neighbourhood.1",
            text: "Altstadt",
            place_name: "Altstadt, Köln",
            place_type: ["neighbourhood"],
            relevance: 0.5,
            geometry: { coordinates: [6.96, 50.94] },
          },
        ],
      }),
    );

    const [result] = await maptilerGeocodingService.geocode("Altstadt");
    expect(result?.type).toBe("street");
  });

  it("maps autocomplete features with text label, place_name sublabel and category", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            id: "poi.123",
            text: "Köln Hauptbahnhof",
            place_name: "Köln Hauptbahnhof, Köln, Germany",
            place_type: ["poi"],
            relevance: 1,
            geometry: { coordinates: [6.9582814, 50.9430759] },
            properties: { categories: ["railway_station"] },
          },
        ],
      }),
    );

    const [result] = await maptilerGeocodingService.autocomplete("Köln");

    expect(result).toMatchObject({
      id: "maptiler:poi.123",
      label: "Köln Hauptbahnhof",
      sublabel: "Köln Hauptbahnhof, Köln, Germany",
      coordinates: [6.9582814, 50.9430759],
      type: "poi",
      rawCategory: "railway_station",
    });
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("autocomplete=true");
  });

  it("passes on a place's Wikidata item and how widely its tags say it is known", async () => {
    const poi = (id: string, wikidata: string | undefined, tags: Record<string, unknown>) => ({
      id,
      text: id,
      place_name: id,
      place_type: ["poi"],
      relevance: 1,
      geometry: { coordinates: [0, 0] },
      properties: { ...(wikidata ? { wikidata } : {}), feature_tags: tags },
    });
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          poi("Colosseum", "Q10285", { importance: "international", heritage: "1" }),
          poi("Sagrada Família", "Q48435", { heritage: "1" }),
          poi("Rathaus", "Q123", { importance: "regional" }),
          poi("Louvre bar", undefined, { amenity: "bar" }),
        ],
      }),
    );

    const results = await maptilerGeocodingService.autocomplete("x");

    expect(results.map((result) => [result.ids?.wikidata, result.fame])).toEqual([
      ["Q10285", 0.85],
      ["Q48435", 0.8],
      ["Q123", 0.45],
      [undefined, undefined],
    ]);
  });

  it("reports an area's settlement rank so ranking can tell a city from a hamlet", async () => {
    const area = (id: string, placeType: string, designation?: string) => ({
      id,
      text: id,
      place_name: id,
      place_type: [placeType],
      relevance: 1,
      geometry: { coordinates: [0, 0] },
      properties: designation ? { place_designation: designation } : {},
    });
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          area("Munich", "county", "city"),
          area("Coffee", "county", "hamlet"),
          area("Bavaria", "region"),
          area("Hauptstraße 1", "address"),
        ],
      }),
    );

    const results = await maptilerGeocodingService.autocomplete("m");

    expect(results.map((result) => result.rawCategory)).toEqual([
      "place/city",
      "place/hamlet",
      "place/region",
      undefined,
    ]);
  });

  it("sends the autocomplete bias as proximity=lng,lat and omits it when absent", async () => {
    mockFetch.mockImplementation(async () => mockOk({ features: [] }));

    await maptilerGeocodingService.autocomplete("coffee", "de", {
      proximity: [13.4, 52.52],
      zoom: 14,
    });
    await maptilerGeocodingService.autocomplete("coffee", "de");

    const biased = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams;
    expect(biased.get("proximity")).toBe("13.4,52.52");
    const unbiased = new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams;
    expect(unbiased.has("proximity")).toBe(false);
  });

  it("extracts city + region from reverse-geocode context", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            id: "address.1",
            text: "Bahnhofsvorplatz 1",
            place_name: "Bahnhofsvorplatz 1, Köln, North Rhine-Westphalia, Germany",
            place_type: ["address"],
            relevance: 1,
            geometry: { coordinates: [6.96, 50.94] },
            context: [
              { id: "municipality.111", text: "Köln" },
              { id: "region.222", text: "North Rhine-Westphalia" },
              { id: "country.333", text: "Germany" },
            ],
          },
        ],
      }),
    );

    const result = await maptilerGeocodingService.reverseGeocode(50.94, 6.96);

    expect(result).toEqual({
      address: "Bahnhofsvorplatz 1, Köln, North Rhine-Westphalia, Germany",
      city: "Köln, North Rhine-Westphalia",
      addressEvidence: {
        components: { municipality: "Köln", state: "North Rhine-Westphalia", country: "Germany" },
        source: "geocoding-maptiler",
        method: "reverse",
        recordId: "maptiler:address.1",
      },
    });
    // reverse uses lng,lat in the path, not the search query form.
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/geocoding/6.96,50.94.json");
  });

  it("returns null reverse-geocode when there are no features", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [] }));
    expect(await maptilerGeocodingService.reverseGeocode(0, 0)).toBeNull();
  });

  it("throws when no API key is configured", async () => {
    setMaptilerApiKey(undefined);
    await expect(maptilerGeocodingService.geocode("anything")).rejects.toThrow(/API key/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("resolveMaptilerApiKey", () => {
  it("prefers the integration's own key and falls back to MAPTILER_KEY", () => {
    expect(resolveMaptilerApiKey("own", { MAPTILER_KEY: "shared" })).toBe("own");
    expect(resolveMaptilerApiKey(undefined, { MAPTILER_KEY: "shared" })).toBe("shared");
    expect(resolveMaptilerApiKey(" ", { MAPTILER_KEY: " " })).toBeUndefined();
  });
});
