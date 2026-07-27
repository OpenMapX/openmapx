import { describe, expect, it } from "vitest";
import type { DeliveryQuery } from "../types.js";
import { matchUberEatsStoreUrl, type UberFeedItem, uberEatsProvider } from "./ubereats.js";

const query: DeliveryQuery = {
  name: "L'Osteria",
  countryCode: "de",
  lat: 50.771968,
  lng: 6.085821,
};

function store(
  title: string,
  latitude = query.lat as number,
  longitude = query.lng as number,
  actionUrl = "/store/losteria/id",
): UberFeedItem {
  return {
    type: "REGULAR_STORE",
    store: { title: { text: title }, actionUrl, mapMarker: { latitude, longitude } },
  };
}

describe("Uber Eats exact-store matching", () => {
  it("matches normalized exact names and canonicalizes the country URL", () => {
    expect(matchUberEatsStoreUrl(query, [store("L’Osteria")])).toBe(
      "https://www.ubereats.com/de/store/losteria/id",
    );
  });

  it("allows a whole-token branch suffix and chooses the nearest branch", () => {
    const far = store("L'Osteria Aachen", 50.79, 6.1, "/store/losteria/far");
    const near = store("L'Osteria Aachen", 50.772, 6.086, "/store/losteria/near");
    expect(matchUberEatsStoreUrl(query, [far, near])).toContain("/near");
  });

  it("rejects the live Mo substring regression", () => {
    const mo = { ...query, name: "Mo", lat: 50.7713613, lng: 6.0848189 };
    expect(matchUberEatsStoreUrl(mo, [store("Ouis – Moroccan Soulfood")])).toBeNull();
    expect(matchUberEatsStoreUrl(mo, [store("Moco Chicken Aachen")])).toBeNull();
  });

  it("rejects generic single-token containment", () => {
    expect(matchUberEatsStoreUrl({ ...query, name: "Pizza" }, [store("Pizza Hut")])).toBeNull();
  });

  it("matches a nearby distinctive one-word brand with an Uber branch suffix", () => {
    const frittenwerk = { ...query, name: "Frittenwerk", lat: 50.775068, lng: 6.08779 };
    expect(
      matchUberEatsStoreUrl(frittenwerk, [
        store(
          "Frittenwerk Aachen Holzgraben",
          50.7751,
          6.0878,
          "/store/frittenwerk-aachen-holzgraben/af0fUjcsVYG8WCs5EqgQmQ",
        ),
      ]),
    ).toBe(
      "https://www.ubereats.com/de/store/frittenwerk-aachen-holzgraben/af0fUjcsVYG8WCs5EqgQmQ",
    );
  });

  it("rejects a distant branch for the relaxed one-word brand match", () => {
    const frittenwerk = { ...query, name: "Frittenwerk", lat: 50.775068, lng: 6.08779 };
    expect(
      matchUberEatsStoreUrl(frittenwerk, [
        store("Frittenwerk Aachen", 50.779, 6.0878, "/store/frittenwerk-aachen/other"),
      ]),
    ).toBeNull();
  });

  it("preserves non-Latin names for exact matching", () => {
    expect(matchUberEatsStoreUrl({ ...query, name: "すし処" }, [store("すし処")])).toContain(
      "/store/",
    );
  });

  it("rejects markerless, malformed, and distant candidates", () => {
    expect(
      matchUberEatsStoreUrl(query, [
        { type: "REGULAR_STORE", store: { title: { text: "L'Osteria" }, actionUrl: "/store/x/y" } },
      ]),
    ).toBeNull();
    expect(matchUberEatsStoreUrl(query, [store("L'Osteria", 50.9, 6.2)])).toBeNull();
    expect(
      matchUberEatsStoreUrl(query, [store("L'Osteria", undefined, undefined, "/search")]),
    ).toBeNull();
  });
});

describe("Uber Eats search handoff", () => {
  it("uses the working search-bar route instead of the broken feed query route", () => {
    const url = new URL(
      uberEatsProvider.build(
        {
          name: "Frittenwerk",
          countryCode: "de",
          city: "Aachen",
          address: "Holzgraben 4, 52062 Aachen, Germany",
          lat: 50.775068,
          lng: 6.08779,
        },
        {},
      ),
    );

    expect(url.pathname).toBe("/de/search");
    expect(url.searchParams.get("q")).toBe("Frittenwerk");
    expect(url.searchParams.get("diningMode")).toBe("DELIVERY");
    expect(url.searchParams.get("sc")).toBe("SEARCH_BAR");
    expect(url.searchParams.get("searchType")).toBe("GLOBAL_SEARCH");
    expect(url.searchParams.get("vertical")).toBe("ALL");
    expect(url.searchParams.get("pl")).toBeTruthy();
  });
});
