import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nominatimService, setNominatimUrl } from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setNominatimUrl("https://nominatim.test");
});

afterEach(() => {
  setNominatimUrl("https://nominatim.openstreetmap.org");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Nominatim geocoding provider", () => {
  it("maps geocode results with canonical osm ids, type and rawCategory", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          place_id: 1,
          osm_type: "node",
          osm_id: 240095639,
          lat: "50.9430759",
          lon: "6.9582814",
          display_name: "Köln Hauptbahnhof, Köln, Germany",
          name: "Köln Hauptbahnhof",
          category: "railway",
          type: "station",
          importance: 0.62,
        },
        {
          place_id: 2,
          osm_type: "way",
          osm_id: 12345,
          lat: "50.94",
          lon: "6.95",
          display_name: "Domkloster, Köln, Germany",
          category: "highway",
          type: "residential",
          importance: 0.3,
        },
        {
          place_id: 3,
          osm_type: "relation",
          osm_id: 62578,
          lat: "50.93",
          lon: "6.96",
          display_name: "Köln, Germany",
          category: "boundary",
          type: "administrative",
          importance: 0.7,
        },
      ]),
    );

    const results = await nominatimService.geocode("Köln Hbf", "de");

    expect(results).toEqual([
      {
        id: "osm:node/240095639",
        label: "Köln Hauptbahnhof, Köln, Germany",
        coordinates: [6.9582814, 50.9430759],
        type: "region",
        confidence: 0.62,
        rawCategory: "railway/station",
      },
      {
        id: "osm:way/12345",
        label: "Domkloster, Köln, Germany",
        coordinates: [6.95, 50.94],
        type: "street",
        confidence: 0.3,
        rawCategory: "highway/residential",
      },
      {
        id: "osm:relation/62578",
        label: "Köln, Germany",
        coordinates: [6.96, 50.93],
        type: "region",
        confidence: 0.7,
        rawCategory: "boundary/administrative",
      },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/search");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("format=jsonv2");
  });

  it("classifies amenity/shop/tourism/leisure as poi", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          place_id: 9,
          osm_type: "node",
          osm_id: 7,
          lat: "0",
          lon: "0",
          display_name: "A Cafe",
          name: "A Cafe",
          category: "amenity",
          type: "cafe",
          importance: 0.1,
        },
      ]),
    );

    const [result] = await nominatimService.geocode("cafe");
    expect(result?.type).toBe("poi");
  });

  it("ranks a city mapped as its boundary as the city, with Nominatim's importance", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          place_id: 1,
          osm_type: "relation",
          osm_id: 62578,
          lat: "50.94",
          lon: "6.96",
          display_name: "Köln, Nordrhein-Westfalen, Deutschland",
          name: "Köln",
          category: "boundary",
          type: "administrative",
          addresstype: "city",
          importance: 0.76,
        },
      ]),
    );

    const [result] = await nominatimService.autocomplete("köln");

    expect(result).toMatchObject({
      type: "region",
      rawCategory: "place/city",
      importance: 0.76,
    });
  });

  it("derives a street line for unnamed address features in autocomplete", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          place_id: 4,
          osm_type: "way",
          osm_id: 999,
          lat: "51.96",
          lon: "7.62",
          display_name: "40, Kinderhauser Straße, Münster, Germany",
          category: "place",
          type: "house",
          importance: 0.2,
          address: {
            road: "Kinderhauser Straße",
            house_number: "40",
            country_code: "de",
          },
        },
      ]),
    );

    const [result] = await nominatimService.autocomplete("Kinderhauser");

    expect(result?.id).toBe("osm:way/999");
    expect(result?.type).toBe("address");
    expect(result?.sublabel).toBe("40, Kinderhauser Straße, Münster, Germany");
    // formatStreetLine renders the DE house-number-after-street order rather
    // than the bare "40" that display_name.split(",")[0] would yield.
    expect(result?.label).toBe("Kinderhauser Straße 40");
    expect(result?.rawCategory).toBe("place/house");
  });

  it("prefers the POI name as the autocomplete label when present", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          place_id: 5,
          osm_type: "node",
          osm_id: 1,
          lat: "50.94",
          lon: "6.95",
          display_name: "Köln Hauptbahnhof, Köln, Germany",
          name: "Köln Hauptbahnhof",
          category: "railway",
          type: "station",
          importance: 0.6,
        },
      ]),
    );

    const [result] = await nominatimService.autocomplete("Köln");
    expect(result?.label).toBe("Köln Hauptbahnhof");
    expect(result?.sublabel).toBe("Köln Hauptbahnhof, Köln, Germany");
  });

  it("biases autocomplete with an unbounded viewbox sized from the zoom", async () => {
    mockFetch.mockImplementation(async () => mockOk([]));

    await nominatimService.autocomplete("coffee", "de", { proximity: [0, 0], zoom: 10 });
    await nominatimService.autocomplete("coffee", "de", { proximity: [0, 0] });
    await nominatimService.autocomplete("coffee", "de");

    const zoomed = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams;
    // 360 / 2^10 = 0.3515625 degrees each side at the equator.
    expect(zoomed.get("viewbox")).toBe("-0.3515625,-0.3515625,0.3515625,0.3515625");
    expect(zoomed.has("bounded")).toBe(false);

    const defaultZoom = new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams;
    expect(defaultZoom.get("viewbox")).toBe("-0.087890625,-0.087890625,0.087890625,0.087890625");

    const unbiased = new URL(String(mockFetch.mock.calls[2]?.[0])).searchParams;
    expect(unbiased.has("viewbox")).toBe(false);
  });

  it("builds a reverse-geocode address from the matched feature", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        display_name: "1, Bahnhofsvorplatz, Köln, North Rhine-Westphalia, Germany",
        address: {
          house_number: "1",
          road: "Bahnhofsvorplatz",
          city: "Köln",
          state: "North Rhine-Westphalia",
          postcode: "50667",
          country: "Germany",
          country_code: "de",
        },
      }),
    );

    const result = await nominatimService.reverseGeocode(50.9404, 6.9606);

    expect(result).not.toBeNull();
    expect(result?.address).toContain("Bahnhofsvorplatz");
    expect(result?.address).toContain("Köln");
    expect(result?.city).toBe("Köln, North Rhine-Westphalia");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/reverse");
  });

  it("returns null reverse-geocode when the response carries an error", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ error: "Unable to geocode", display_name: "" }));
    expect(await nominatimService.reverseGeocode(0, 0)).toBeNull();
  });

  it("returns null reverse-geocode on a non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    expect(await nominatimService.reverseGeocode(0, 0)).toBeNull();
  });
});
