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

  const params = (call: number) => new URL(String(mockFetch.mock.calls[call]?.[0])).searchParams;
  const photonFeature = (osmId: number, name: string) => ({
    geometry: { coordinates: [13.4, 52.52] },
    properties: { osm_id: osmId, osm_type: "N", osm_key: "amenity", osm_value: "cafe", name },
  });

  it("asks once near the map and once wide, so both nearby and famous far places come back", async () => {
    mockFetch.mockImplementation(async () => mockOk({ features: [] }));

    await photonService.autocomplete("coffee", "de", { proximity: [13.4, 52.52], zoom: 20.7 });

    const local = params(0);
    expect(local.get("lat")).toBe("52.52");
    expect(local.get("lon")).toBe("13.4");
    expect(local.get("zoom")).toBe("14");
    expect(local.get("location_bias_scale")).toBe("0.2");
    const wide = params(1);
    expect(wide.get("lat")).toBe("52.52");
    expect(wide.get("zoom")).toBe("10");
    expect(wide.get("location_bias_scale")).toBe("0.5");
    expect(wide.get("limit")).toBe("10");
  });

  it("keeps a zoomed-out map's own radius and defaults the radius without a zoom", async () => {
    mockFetch.mockImplementation(async () => mockOk({ features: [] }));

    await photonService.autocomplete("coffee", "de", { proximity: [13.4, 52.52], zoom: 6.4 });
    await photonService.autocomplete("coffee", "de", { proximity: [13.4, 52.52] });

    expect([params(0).get("zoom"), params(1).get("zoom")]).toEqual(["6", "6"]);
    expect([params(2).get("zoom"), params(3).get("zoom")]).toEqual(["14", "10"]);
  });

  it("sends a single unbiased lookup without a location", async () => {
    mockFetch.mockImplementation(async () => mockOk({ features: [] }));

    await photonService.autocomplete("coffee", "de");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(params(0).has("lat")).toBe(false);
    expect(params(0).has("zoom")).toBe(false);
  });

  it("merges both lookups without repeating a place, nearby answers first", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockOk({ features: [photonFeature(1, "Near"), photonFeature(2, "Both")] }),
      )
      .mockResolvedValueOnce(
        mockOk({ features: [photonFeature(2, "Both"), photonFeature(3, "Far")] }),
      );

    const results = await photonService.autocomplete("coffee", "de", { proximity: [13.4, 52.52] });

    expect(results.map((result) => result.label)).toEqual(["Near", "Both", "Far"]);
  });

  it("answers from one lookup when the other fails, and fails only when both do", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(mockOk({ features: [photonFeature(3, "Far")] }));
    const results = await photonService.autocomplete("coffee", "de", { proximity: [13.4, 52.52] });
    expect(results.map((result) => result.label)).toEqual(["Far"]);

    mockFetch.mockRejectedValue(new Error("down"));
    await expect(
      photonService.autocomplete("coffee", "de", { proximity: [13.4, 52.52] }),
    ).rejects.toThrow();
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
