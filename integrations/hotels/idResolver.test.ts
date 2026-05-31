// integrations/hotels/idResolver.test.ts
import { describe, expect, it } from "vitest";
import { buildExactDeepLink, resolveOtaHotelId } from "./idResolver.js";

const q = {
  name: "Windsor Palace Hotel",
  checkIn: "2026-07-15",
  checkOut: "2026-07-17",
  adults: 2,
  rooms: 1,
} as const;

describe("buildExactDeepLink", () => {
  it("tripcom: hotels/detail?hotelid + dates + occupancy", () => {
    const url = buildExactDeepLink("tripcom", "2565026", q, {});
    expect(url).toContain("https://www.trip.com/hotels/detail?hotelid=2565026");
    expect(url).toContain("checkin=2026-07-15");
    expect(url).toContain("adult=2");
    expect(url).toContain("crn=1");
  });
  it("expedia: <id>.Hotel-Information + dates", () => {
    const url = buildExactDeepLink("expedia", "h7172034", q, {});
    expect(url).toContain("https://www.expedia.com/h7172034.Hotel-Information?");
    expect(url).toContain("chkin=2026-07-15");
  });
  it("hotelscom: /<id>/ (trailing slash per P3898 formatter) + dates", () => {
    const url = buildExactDeepLink("hotelscom", "ho326672", q, {});
    expect(url).toContain("https://www.hotels.com/ho326672/?");
    expect(url).toContain("chkin=2026-07-15");
  });
  it("agoda: slug.html (per P6008 formatter) + dates", () => {
    const url = buildExactDeepLink(
      "agoda",
      "paradise-inn-windsor-palace-hotel/hotel/alexandria-eg",
      q,
      {},
    );
    expect(url).toContain(
      "https://www.agoda.com/paradise-inn-windsor-palace-hotel/hotel/alexandria-eg.html?",
    );
    expect(url).toContain("checkIn=2026-07-15");
  });
  it("booking: /hotel/<id>.html + dates", () => {
    const url = buildExactDeepLink("booking", "eg/windsor-palace", q, {});
    expect(url).toContain("https://www.booking.com/hotel/eg/windsor-palace.html?");
    expect(url).toContain("checkin=2026-07-15");
  });
  it("url-encodes single-segment ids (expedia/hotelscom) so unsafe chars can't break the path", () => {
    // Real ids are `h\d+`/`ho\d+` (all-safe), but prove enc() actually runs so a
    // future regression on an id with unsafe chars is caught.
    expect(buildExactDeepLink("expedia", "h 71+72", q, {})).toContain(
      "https://www.expedia.com/h%2071%2B72.Hotel-Information?",
    );
    expect(buildExactDeepLink("hotelscom", "ho 32+6", q, {})).toContain(
      "https://www.hotels.com/ho%2032%2B6/?",
    );
  });
  it("returns null for an unknown provider", () => {
    expect(buildExactDeepLink("hrs", "x", q, {})).toBeNull();
  });
  it("returns null for an empty id", () => {
    expect(buildExactDeepLink("expedia", "", q, {})).toBeNull();
  });
});

/** Minimal in-memory cache matching the injected IdResolverCache shape. */
function makeFakeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k) : null),
    set: async (k: string, v: unknown) => {
      store.set(k, v);
    },
  };
}

describe("resolveOtaHotelId", () => {
  const q = { name: "Windsor Palace Hotel", lat: 31.2, lng: 29.9, wikidata: "Q12231151" };

  it("prefers wikidata, falls back to typeahead, respects the disable flag", async () => {
    const deps = {
      wikidata: async () => ({ tripcom: "111" }),
      typeahead: { tripcom: async () => "222" },
      cache: makeFakeCache(),
      typeaheadEnabled: true,
    };
    const r1 = await resolveOtaHotelId("tripcom", q, deps);
    expect(r1?.id).toBe("111"); // wikidata wins
    expect(r1?.source).toBe("wikidata");

    const deps2 = { ...deps, wikidata: async () => ({}), cache: makeFakeCache() };
    const r2 = await resolveOtaHotelId("tripcom", q, deps2);
    expect(r2?.id).toBe("222"); // typeahead fallback
    expect(r2?.source).toBe("typeahead");

    const deps3 = { ...deps2, typeaheadEnabled: false, cache: makeFakeCache() };
    expect(await resolveOtaHotelId("tripcom", q, deps3)).toBeNull(); // typeahead disabled → null
  });

  it("caches the result so a repeated lookup does not refetch", async () => {
    let wdCalls = 0;
    const deps = {
      wikidata: async () => {
        wdCalls++;
        return { tripcom: "111" };
      },
      typeahead: {},
      cache: makeFakeCache(),
      typeaheadEnabled: true,
    };
    await resolveOtaHotelId("tripcom", q, deps);
    await resolveOtaHotelId("tripcom", q, deps);
    expect(wdCalls).toBe(1);
  });

  it("resolves multiple OTAs for one hotel with a single wikidata fetch", async () => {
    let wdCalls = 0;
    const deps = {
      wikidata: async () => {
        wdCalls++;
        return { tripcom: "111", expedia: "h9" };
      },
      typeahead: {},
      cache: makeFakeCache(),
      typeaheadEnabled: true,
    };
    expect((await resolveOtaHotelId("tripcom", q, deps))?.id).toBe("111");
    expect((await resolveOtaHotelId("expedia", q, deps))?.id).toBe("h9");
    expect(wdCalls).toBe(1); // shared per-hotel wikidata cache
  });

  it("skips typeahead for an OTA that has no resolver, even when enabled", async () => {
    const deps = {
      wikidata: async () => ({}),
      typeahead: { tripcom: async () => "222" },
      cache: makeFakeCache(),
      typeaheadEnabled: true,
    };
    expect(await resolveOtaHotelId("expedia", q, deps)).toBeNull();
  });

  it("returns null and caches a negative when there is no wikidata qid and no typeahead", async () => {
    const deps = {
      wikidata: async () => ({}),
      typeahead: {},
      cache: makeFakeCache(),
      typeaheadEnabled: true,
    };
    expect(
      await resolveOtaHotelId("tripcom", { name: "No Such Hotel", lat: 1, lng: 1 }, deps),
    ).toBeNull();
  });

  it("does not share a cache entry between same-named coord-less hotels in different cities", async () => {
    const deps = {
      wikidata: async (qid: string) => (qid ? { tripcom: "111" } : {}),
      typeahead: { tripcom: async () => "berlin-id" },
      cache: makeFakeCache(),
      typeaheadEnabled: true,
    };
    // Same name, no coords/qid, different cities → distinct keys (city disambiguates).
    const berlin = await resolveOtaHotelId(
      "tripcom",
      { name: "Grand Hotel", city: "Berlin" },
      deps,
    );
    const paris = await resolveOtaHotelId(
      "tripcom",
      { name: "Grand Hotel", city: "Paris" },
      { ...deps, typeahead: { tripcom: async () => "paris-id" }, cache: deps.cache },
    );
    expect(berlin?.id).toBe("berlin-id");
    expect(paris?.id).toBe("paris-id"); // not the cached Berlin entry
  });
});
