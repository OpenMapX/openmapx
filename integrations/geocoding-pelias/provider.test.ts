import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeIdFromGid, mapLayer, peliasService, setPeliasUrl } from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setPeliasUrl("http://pelias.test");
});

afterEach(() => {
  setPeliasUrl("http://localhost:4300");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("makeIdFromGid", () => {
  it.each([
    ["openstreetmap:venue:node/123456", "osm:node/123456"],
    ["openstreetmap:address:way/987654", "osm:way/987654"],
    ["openstreetmap:street:relation/555", "osm:relation/555"],
    ["whosonfirst:locality:85682183", "pelias-whosonfirst:85682183"],
    ["geonames:locality:2950159", "pelias-geonames:2950159"],
    // openstreetmap source but a non-canonical inner id falls back to the
    // pelias- scheme rather than emitting a malformed osm: ref.
    ["openstreetmap:venue:abc123", "pelias-openstreetmap:abc123"],
  ])("canonicalizes %s -> %s", (gid, expected) => {
    expect(makeIdFromGid(gid)).toBe(expected);
  });
});

describe("mapLayer", () => {
  it.each([
    ["venue", "poi"],
    ["address", "address"],
    ["street", "street"],
    ["locality", "region"],
    ["localadmin", "region"],
    ["county", "region"],
    ["region", "region"],
    ["country", "region"],
    ["continent", "region"],
    ["something-unknown", "poi"],
  ] as const)("maps layer %s -> %s", (layer, expected) => {
    expect(mapLayer(layer)).toBe(expected);
  });
});

describe("Pelias geocoding provider", () => {
  it("maps geocode features with canonical ids, layers, coords and confidence", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [6.9606, 50.9404] },
            properties: {
              gid: "openstreetmap:venue:node/123456",
              label: "Köln Hauptbahnhof, Köln, Germany",
              name: "Köln Hauptbahnhof",
              layer: "venue",
              confidence: 0.95,
            },
          },
          {
            geometry: { coordinates: [6.9583, 50.9413] },
            properties: {
              gid: "whosonfirst:locality:101748073",
              label: "Köln, Germany",
              name: "Köln",
              layer: "locality",
              confidence: 0.8,
            },
          },
        ],
      }),
    );

    const results = await peliasService.geocode("Köln Hbf", "de");

    expect(results).toEqual([
      {
        id: "osm:node/123456",
        label: "Köln Hauptbahnhof, Köln, Germany",
        coordinates: [6.9606, 50.9404],
        type: "poi",
        confidence: 0.95,
      },
      {
        id: "pelias-whosonfirst:101748073",
        label: "Köln, Germany",
        coordinates: [6.9583, 50.9413],
        type: "region",
        confidence: 0.8,
      },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/v1/search");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("text=K%C3%B6ln+Hbf");
  });

  it("builds a reverse-geocode address with city + region", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [6.9606, 50.9404] },
            properties: {
              gid: "openstreetmap:address:way/42",
              label: "Bahnhofsvorplatz 1, Köln, Germany",
              name: "Bahnhofsvorplatz 1",
              layer: "address",
              confidence: 0.9,
              locality: "Köln",
              region: "North Rhine-Westphalia",
            },
          },
        ],
      }),
    );

    const result = await peliasService.reverseGeocode(50.9404, 6.9606);

    expect(result).toEqual({
      address: "Bahnhofsvorplatz 1, Köln, Germany",
      city: "Köln, North Rhine-Westphalia",
    });
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/v1/reverse");
  });

  it("returns null reverse-geocode when there are no features", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [] }));
    expect(await peliasService.reverseGeocode(0, 0)).toBeNull();
  });

  it("maps autocomplete features with name labels and joined sublabels", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [6.9606, 50.9404] },
            properties: {
              gid: "openstreetmap:venue:node/123456",
              label: "Köln Hauptbahnhof, Köln, Germany",
              name: "Köln Hauptbahnhof",
              layer: "venue",
              confidence: 0.95,
              locality: "Köln",
              region: "North Rhine-Westphalia",
              country: "Germany",
            },
          },
        ],
      }),
    );

    const results = await peliasService.autocomplete("Köln");

    expect(results).toEqual([
      {
        id: "osm:node/123456",
        label: "Köln Hauptbahnhof",
        sublabel: "Köln, North Rhine-Westphalia, Germany",
        coordinates: [6.9606, 50.9404],
        type: "poi",
      },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/v1/autocomplete");
  });

  it("omits the autocomplete sublabel when no admin parts are present", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [0, 0] },
            properties: {
              gid: "whosonfirst:country:0",
              label: "Nowhere",
              name: "Nowhere",
              layer: "country",
              confidence: 0.1,
            },
          },
        ],
      }),
    );

    const [result] = await peliasService.autocomplete("Nowhere");
    expect(result?.sublabel).toBeUndefined();
    expect(result?.type).toBe("region");
  });
});
