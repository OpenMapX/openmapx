import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { photonService, setPhotonUrl } from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setPhotonUrl("https://photon.test");
});

afterEach(() => {
  setPhotonUrl("https://photon.komoot.io");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Photon geocoding provider", () => {
  it("expands single-char osm types into canonical osm ids and maps type", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [6.9582814, 50.9430759] },
            properties: {
              osm_id: 240095639,
              osm_type: "N",
              osm_key: "railway",
              osm_value: "station",
              name: "Köln Hauptbahnhof",
              city: "Köln",
              country: "Germany",
            },
          },
          {
            geometry: { coordinates: [7.62, 51.96] },
            properties: {
              osm_id: 999,
              osm_type: "W",
              osm_key: "highway",
              osm_value: "residential",
              street: "Kinderhauser Straße",
              city: "Münster",
              country: "Germany",
            },
          },
          {
            geometry: { coordinates: [6.95, 50.93] },
            properties: {
              osm_id: 62578,
              osm_type: "R",
              osm_key: "boundary",
              osm_value: "administrative",
              name: "Köln",
              country: "Germany",
            },
          },
        ],
      }),
    );

    const results = await photonService.geocode("Köln", "de");

    expect(results).toEqual([
      {
        id: "osm:node/240095639",
        label: "Köln Hauptbahnhof, Köln, Germany",
        coordinates: [6.9582814, 50.9430759],
        type: "poi",
        confidence: 1,
        rawCategory: "railway/station",
      },
      {
        id: "osm:way/999",
        label: "Kinderhauser Straße, Münster, Germany",
        coordinates: [7.62, 51.96],
        type: "street",
        confidence: 1,
        rawCategory: "highway/residential",
      },
      {
        id: "osm:relation/62578",
        label: "Köln, Germany",
        coordinates: [6.95, 50.93],
        type: "region",
        confidence: 1,
        rawCategory: "boundary/administrative",
      },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/api");
  });

  it("builds a label with house number after street and falls back when empty", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [7.62, 51.96] },
            properties: {
              osm_id: 1,
              osm_type: "N",
              osm_key: "place",
              osm_value: "house",
              street: "Kinderhauser Straße",
              housenumber: "40",
              city: "Münster",
              country: "Germany",
            },
          },
          {
            geometry: { coordinates: [0, 0] },
            properties: {
              osm_id: 2,
              osm_type: "N",
              osm_key: "amenity",
              osm_value: "bench",
            },
          },
        ],
      }),
    );

    const results = await photonService.geocode("test");
    expect(results[0]?.label).toBe("Kinderhauser Straße 40, Münster, Germany");
    expect(results[0]?.type).toBe("region");
    expect(results[1]?.label).toBe("Unknown location");
  });

  it("sets autocomplete sublabel only when the short name differs from the full label", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [6.95, 50.94] },
            properties: {
              osm_id: 5,
              osm_type: "N",
              osm_key: "railway",
              osm_value: "station",
              name: "Köln Hauptbahnhof",
              city: "Köln",
              country: "Germany",
            },
          },
          {
            geometry: { coordinates: [0, 0] },
            properties: {
              osm_id: 6,
              osm_type: "N",
              osm_key: "place",
              osm_value: "city",
              name: "Solo",
            },
          },
        ],
      }),
    );

    const results = await photonService.autocomplete("Köln");

    expect(results[0]).toMatchObject({
      id: "osm:node/5",
      label: "Köln Hauptbahnhof",
      sublabel: "Köln Hauptbahnhof, Köln, Germany",
      coordinates: [6.95, 50.94],
      type: "poi",
      rawCategory: "railway/station",
    });
    // short === full (name only, no city/country) -> sublabel omitted.
    expect(results[1]?.label).toBe("Solo");
    expect(results[1]?.sublabel).toBeUndefined();
  });

  it("builds a reverse-geocode address with city + state", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [6.95, 50.94] },
            properties: {
              osm_id: 7,
              osm_type: "N",
              osm_key: "place",
              osm_value: "house",
              street: "Bahnhofsvorplatz",
              housenumber: "1",
              city: "Köln",
              state: "North Rhine-Westphalia",
              country: "Germany",
            },
          },
        ],
      }),
    );

    const result = await photonService.reverseGeocode(50.94, 6.95);

    expect(result).toEqual({
      address: "Bahnhofsvorplatz 1, Köln, Germany",
      city: "Köln, North Rhine-Westphalia",
    });
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/reverse");
  });

  it("returns null reverse-geocode when there are no features", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [] }));
    expect(await photonService.reverseGeocode(0, 0)).toBeNull();
  });
});
