import { describe, expect, it } from "vitest";
import type { Place } from "../types/place";
import { directPlaceDetailsId, hasUsablePlaceAddress, selectPlaceAddress } from "./addressEvidence";

const selected = {
  id: "osm:way/1",
  primaryScheme: "osm",
  ids: { osm: "way/1" },
  name: "Shop",
  address: "Grunerstraße 20, Berlin",
  city: "Berlin",
  coordinates: [13, 52],
  addressEvidence: {
    source: "overpass",
    method: "osm-tags",
    recordId: "osm:way/1",
    components: { road: "Grunerstraße", house_number: "20" },
  },
} satisfies Place;
const context: Place = {
  ...selected,
  address: "Alexanderstraße, Berlin",
  addressEvidence: {
    source: "geocoding-nominatim",
    method: "provider-address",
    recordId: "osm:way/1",
    components: { road: "Alexanderstraße", city: "Berlin" },
  },
};

describe("address selection", () => {
  it("preserves explicit own tags over conflicting provider hierarchy", () => {
    expect(selectPlaceAddress(selected, context, false)).toBe(selected);
    const partial = {
      ...selected,
      address: "Grunerstraße",
      addressEvidence: { ...selected.addressEvidence, components: { road: "Grunerstraße" } },
    };
    expect(selectPlaceAddress(partial, context, false)).toBe(partial);
  });
  it("does not choose a longer uncertain address or join its number onto context", () => {
    const maptiler = {
      ...selected,
      id: "maptiler:poi.1",
      primaryScheme: "maptiler",
      ids: { maptiler: "poi.1" },
      address: "Alexanderstraße 25, Berlin",
      addressEvidence: {
        source: "geocoding-maptiler",
        method: "provider-label" as const,
        components: {},
      },
    };
    expect(selectPlaceAddress(maptiler, context, false)).toBe(context);
  });
  it("accepts explicit resolved tags for the selected object", () => {
    expect(selectPlaceAddress(context, selected, false)).toBe(selected);
  });
  it("refuses an address from another established OSM identity", () => {
    expect(selectPlaceAddress(context, { ...selected, ids: { osm: "way/2" } }, false)).toBe(
      context,
    );
  });
  it("keeps data-source-owned and legacy address precedence", () => {
    const curated = {
      ...context,
      addressEvidence: {
        ...context.addressEvidence,
        source: "fuel",
        method: "provider-address" as const,
        components: { full: context.address },
      },
    };
    expect(selectPlaceAddress(curated, selected, true)).toBe(curated);
    expect(
      selectPlaceAddress(
        {
          ...context,
          addressEvidence: {
            source: "fuel",
            method: "provider-address",
            components: { city: "Berlin" },
          },
        },
        selected,
        true,
      ),
    ).toBe(selected);
    expect(
      selectPlaceAddress(
        { ...selected, addressEvidence: undefined },
        { ...context, addressEvidence: undefined },
        false,
      ),
    ).toEqual({ ...context, addressEvidence: undefined });
  });
  it("accepts full and named-premises addresses without numbers", () => {
    for (const components of [
      { full: "東京都千代田区丸の内" },
      { house: "Rose Cottage", place: "Little Village" },
    ]) {
      expect(
        hasUsablePlaceAddress({
          ...selected,
          addressEvidence: { source: "overpass", method: "osm-tags", components },
        }),
      ).toBe(true);
    }
    expect(hasUsablePlaceAddress(context)).toBe(false);
    expect(
      hasUsablePlaceAddress({
        ...selected,
        name: "Rose Cottage",
        address: "Rose Cottage",
        addressEvidence: {
          source: "overpass",
          method: "osm-tags",
          components: { house: "Rose Cottage" },
        },
      }),
    ).toBe(true);
    expect(
      hasUsablePlaceAddress({ ...selected, address: "Shop", addressEvidence: undefined }),
    ).toBe(false);
  });
});

describe("direct OSM details identity", () => {
  const place = {
    ...selected,
    id: "maptiler:poi.1",
    primaryScheme: "maptiler",
    ids: { maptiler: "poi.1", osm: "way/1" },
    directOsmReference: {
      source: "geocoding-maptiler",
      recordId: "maptiler:poi.1",
      osmRef: "way/1",
    },
  } satisfies Place;
  it("uses a direct reference while leaving the original primary identity intact", () => {
    expect(directPlaceDetailsId(place, false)).toBe("osm:way/1");
    expect(place.id).toBe("maptiler:poi.1");
  });
  it("does not use borrowed, conflicting, malformed, or data-source references", () => {
    for (const p of [
      { ...place, directOsmReference: undefined },
      {
        ...place,
        directOsmReference: { ...place.directOsmReference, recordId: "maptiler:poi.2" },
      },
      { ...place, ids: { ...place.ids, osm: "way/2" } },
      { ...place, directOsmReference: { ...place.directOsmReference, osmRef: "way/1/extra" } },
      {
        ...place,
        ids: { ...place.ids, osm: "way/1\n" },
        directOsmReference: { ...place.directOsmReference, osmRef: "way/1\n" },
      },
    ])
      expect(directPlaceDetailsId(p, false)).toBe(place.id);
    expect(directPlaceDetailsId(place, true)).toBe(place.id);
    expect(directPlaceDetailsId({ ...place, primaryScheme: "coordinate" }, false)).toBe(null);
  });
});
