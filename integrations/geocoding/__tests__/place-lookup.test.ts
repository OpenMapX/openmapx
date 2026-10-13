import type { PlaceAddressComponents } from "@openmapx/core";
import type { MobilityDataSourceProvider } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataSourceResolver } from "../../data-source/resolver.js";
import {
  lookupAddressByCoords,
  lookupByCoords,
  lookupByNameAndCoords,
  lookupByOsmFilters,
  lookupByOsmRef,
} from "../place-lookup.js";

afterEach(() => vi.unstubAllGlobals());

function detail(address: PlaceAddressComponents) {
  return {
    place_id: 1,
    osm_type: "way",
    osm_id: 42,
    name: "Shop",
    lat: "52.52",
    lon: "13.41",
    display_name: "Shop, Berlin",
    category: "shop",
    type: "supermarket",
    address,
  };
}

function stubResponse(body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("reverse address lookup", () => {
  it("retains reverse evidence on an address-only data-source fallback", async () => {
    stubResponse(detail({ road: "Alexanderstraße", house_number: "1", country_code: "de" }));
    const provider = {
      id: "webcam",
      meta: { minZoom: 8, showResultsList: true, markerStyle: { type: "icon" } },
      attribution: [],
      getFilters: async () => [],
      search: async () => ({
        data: [],
        attributions: [],
        freshness: { fetchedAt: "2026-10-13T00:00:00Z", hasRealtimeData: false, isStale: false },
      }),
      getDetail: async () => ({
        data: null,
        attributions: [],
        freshness: { fetchedAt: "2026-10-13T00:00:00Z", hasRealtimeData: false, isStale: false },
      }),
    } satisfies MobilityDataSourceProvider;
    const place = await createDataSourceResolver(provider)("camera-1", { lat: 52.52, lng: 13.41 });
    expect(place).toMatchObject({
      address: "Alexanderstraße 1, Germany",
      countryCode: "de",
      addressEvidence: { source: "geocoding-nominatim", method: "reverse", recordId: "osm:way/42" },
    });
  });

  it("keeps a street-only address without borrowing a nearby building number", async () => {
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("/reverse")
              ? detail({
                  road: "Alexanderstraße",
                  postcode: "10179",
                  city: "Berlin",
                  country_code: "de",
                })
              : {
                  elements: [
                    {
                      type: "node",
                      id: 99,
                      lat: 52.52,
                      lon: 13.41,
                      tags: { "addr:street": "Alexanderstraße", "addr:housenumber": "20" },
                    },
                  ],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await lookupAddressByCoords(52.52, 13.41);
    expect(result?.address).toBe("Alexanderstraße, 10179 Berlin, Germany");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the reverse provider's number as contextual evidence", async () => {
    stubResponse(
      detail({
        road: "Market St",
        house_number: "1",
        city: "San Francisco",
        state: "California",
        postcode: "94102",
        country_code: "us",
      }),
    );
    const result = await lookupAddressByCoords(52.52, 13.41);
    expect(result?.address).toContain("1 Market St");
    expect(result?.addressEvidence).toEqual({
      source: "geocoding-nominatim",
      method: "reverse",
      recordId: "osm:way/42",
      components: {
        road: "Market St",
        house_number: "1",
        city: "San Francisco",
        state: "California",
        postcode: "94102",
        country_code: "us",
      },
    });
  });

  it("accepts an explicit non-street full address", async () => {
    stubResponse(detail({ full: "東京都千代田区丸の内1丁目", country_code: "jp" }));
    expect((await lookupAddressByCoords(52.52, 13.41))?.address).toBe("東京都千代田区丸の内1丁目");
  });

  it("does not expose a city-only reverse response as a premises address", async () => {
    stubResponse(detail({ city: "Berlin", postcode: "10179", country_code: "de" }));
    expect(await lookupAddressByCoords(52.52, 13.41)).toBeNull();
  });
});

describe("Nominatim detail evidence", () => {
  it("preserves available sanitized hierarchy components as provider evidence", async () => {
    stubResponse([
      detail({
        road: " Alexanderstraße ",
        house_number: " ",
        municipality: " Berlin ",
        country_code: "de",
      }),
    ]);
    const place = await lookupByOsmRef("way", "42", "osm:way/42");
    expect(place.addressEvidence).toEqual({
      source: "geocoding-nominatim",
      method: "provider-address",
      recordId: "osm:way/42",
      components: { road: "Alexanderstraße", municipality: "Berlin", country_code: "de" },
    });
  });

  it("marks coordinate detail lookup as reverse rather than explicit OSM tags", async () => {
    stubResponse(detail({ road: "Alexanderstraße", house_number: "1", country_code: "de" }));
    expect(
      (await lookupByCoords(52.52, 13.41, "coordinate:13.41-52.52"))?.addressEvidence?.method,
    ).toBe("reverse");
  });

  it("marks a name search match as provider-address evidence", async () => {
    stubResponse([detail({ road: "Alexanderstraße", country_code: "de" })]);
    expect(
      (await lookupByNameAndCoords("Shop", 52.52, 13.41, "maptiler:shop"))?.addressEvidence?.method,
    ).toBe("provider-address");
  });
});

describe("Overpass own address tags", () => {
  it.each([
    [
      { "addr:full": "東京都千代田区丸の内1丁目", "addr:country": "JP" },
      "東京都千代田区丸の内1丁目",
    ],
    [
      {
        "addr:place": "Little Hamlet",
        "addr:housenumber": "7",
        "addr:postcode": "12345",
        "addr:city": "Town",
        "addr:country": "DE",
      },
      "Little Hamlet 7, 12345 Town",
    ],
    [
      {
        "addr:housename": "Rose Cottage",
        "addr:city": "Little Village",
        "addr:postcode": "AB1 2CD",
        "addr:country": "GB",
      },
      "Rose Cottage, Little Village, AB1 2CD",
    ],
    [
      {
        "addr:street": "Market St",
        "addr:housenumber": "1",
        "addr:city": "San Francisco",
        "addr:state": "California",
        "addr:postcode": "94102",
        "addr:country": "US",
      },
      "1 Market St, San Francisco, CA 94102",
    ],
  ])("formats its own address tags %j", async (addressTags, expected) => {
    stubResponse({
      elements: [
        {
          type: "node",
          id: 42,
          lat: 52.52,
          lon: 13.41,
          tags: { name: "Station", amenity: "bicycle_rental", ...addressTags },
        },
      ],
    });
    const place = await lookupByOsmFilters(
      52.52,
      13.41,
      [{ key: "amenity", value: "bicycle_rental" }],
      "osm:node/42",
    );
    expect(place?.address).toBe(expected);
    expect(place?.addressEvidence).toMatchObject({
      source: "overpass",
      method: "osm-tags",
      recordId: "osm:node/42",
    });
    expect(place?.addressEvidence?.components.country_code).toBe(
      addressTags["addr:country"].toLowerCase(),
    );
  });

  it("does not invent premises from the element's name", async () => {
    stubResponse({
      elements: [
        {
          type: "node",
          id: 42,
          lat: 52.52,
          lon: 13.41,
          tags: { name: "Station", amenity: "bicycle_rental" },
        },
      ],
    });
    const place = await lookupByOsmFilters(
      52.52,
      13.41,
      [{ key: "amenity", value: "bicycle_rental" }],
      "osm:node/42",
    );
    expect(place?.address).toBe("");
    expect(place?.addressEvidence).toBeUndefined();
  });
});
