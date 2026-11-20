import { fakeHttpClient, httpStatus } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import {
  buildOccupancies,
  fetchLiteApiOffer,
  normalizeRatesResponse,
  pickBestHotel,
} from "./liteapi.js";
import type { HotelQuery } from "./types.js";

const q: HotelQuery = {
  name: "Motel One Berlin",
  lat: 52.5,
  lng: 13.33,
  checkIn: "2026-06-10",
  checkOut: "2026-06-12",
  adults: 2,
  rooms: 1,
};

describe("pickBestHotel", () => {
  it("prefers a name match over a closer non-matching hotel", () => {
    const best = pickBestHotel(
      [
        { id: "near", name: "Cheap Hostel", lat: 52.5001, lng: 13.3301 }, // ~15m, no name match
        { id: "match", name: "Motel One Berlin Mitte", lat: 52.502, lng: 13.333 }, // ~300m, name match
      ],
      q,
    );
    expect(best?.id).toBe("match");
  });
  it("falls back to a very-close hotel when no name matches", () => {
    const best = pickBestHotel([{ id: "x", name: "Some Inn", lat: 52.5001, lng: 13.3301 }], q);
    expect(best?.id).toBe("x");
  });
  it("rejects the only candidate when it is far AND unnamed", () => {
    expect(pickBestHotel([{ id: "far", name: "Other", lat: 52.6, lng: 13.5 }], q)).toBeNull();
  });
  it("returns null for no candidates", () => {
    expect(pickBestHotel([], q)).toBeNull();
  });
});

const sample = {
  data: [
    {
      hotelId: "lp123",
      roomTypes: [
        {
          rates: [
            {
              retailRate: { total: [{ amount: 180, currency: "EUR" }] },
              cancellationPolicies: { refundableTag: "RFN" },
            },
            {
              retailRate: {
                total: [{ amount: 150, currency: "EUR" }],
                suggestedSellingPrice: [{ amount: 165, currency: "EUR" }],
              },
              cancellationPolicies: { refundableTag: "NRFN" },
            },
          ],
        },
      ],
    },
  ],
};

describe("buildOccupancies", () => {
  it("single room keeps all guests", () => {
    expect(buildOccupancies(2, 1)).toEqual([{ adults: 2, children: [] }]);
  });
  it("splits total guests evenly across rooms", () => {
    expect(buildOccupancies(4, 2)).toEqual([
      { adults: 2, children: [] },
      { adults: 2, children: [] },
    ]);
  });
  it("distributes the remainder to the first rooms", () => {
    expect(buildOccupancies(3, 2)).toEqual([
      { adults: 2, children: [] },
      { adults: 1, children: [] },
    ]);
  });
  it("caps rooms at the guest count instead of inventing guests", () => {
    // 1 guest + 2 rooms is contradictory (LiteAPI needs ≥1 adult per room); we
    // price 1 occupied room for the 1 guest rather than inflating to 2 adults.
    expect(buildOccupancies(1, 2)).toEqual([{ adults: 1, children: [] }]);
  });
});

describe("normalizeRatesResponse", () => {
  it("picks the lowest total and computes nightly-from over the stay", () => {
    const best = normalizeRatesResponse(sample, 2); // 2 nights
    expect(best).not.toBeNull();
    expect(best?.total).toBe(150);
    expect(best?.currency).toBe("EUR");
    expect(best?.nightlyFrom).toBe(75);
    expect(best?.suggestedSellingPrice).toBe(165);
    expect(best?.refundable).toBe(true); // at least one RFN rate present
  });

  it("returns null for an empty response", () => {
    expect(normalizeRatesResponse({ data: [] }, 1)).toBeNull();
  });
});

describe("fetchLiteApiOffer", () => {
  const options = { currency: "EUR", guestNationality: "de" };
  const nearby = {
    data: [{ id: "lp1", name: "Motel One Berlin", latitude: 52.5, longitude: 13.33 }],
  };

  it("finds the hotel and prices it with the key in a header", async () => {
    const http = fakeHttpClient((req) => (req.method === "get" ? nearby : sample));

    const offer = await fetchLiteApiOffer(http, "secret", options, q);

    expect(offer?.total).toBe(150);
    const [lookup, rates] = http.calls;
    expect(lookup?.url).toBe("https://api.liteapi.travel/v3.0/data/hotels");
    expect(lookup?.options?.params).toMatchObject({ latitude: "52.5", longitude: "13.33" });
    expect(lookup?.options?.headers?.["X-API-Key"]).toBe("secret");
    expect(rates?.method).toBe("post");
    expect(rates?.url).toBe("https://api.liteapi.travel/v3.0/hotels/rates");
    expect(rates?.body).toMatchObject({ hotelIds: ["lp1"], guestNationality: "DE" });
    expect(rates?.options?.headers?.["X-API-Key"]).toBe("secret");
  });

  it("answers no offer when LiteAPI refuses the key", async () => {
    const http = fakeHttpClient(() => httpStatus(401));
    expect(await fetchLiteApiOffer(http, "rejected", options, q)).toBeNull();
    expect(http.calls).toHaveLength(1);
  });
});

describe("LiteAPI payload validation", () => {
  it("ignores rates without a positive amount in an ISO currency", () => {
    const rate = (amount: unknown, currency: unknown) => ({
      retailRate: { total: [{ amount, currency }] },
    });
    const response = {
      data: [
        {
          hotelId: "lp1",
          roomTypes: [
            {
              rates: [rate(0, "EUR"), rate(Number.NaN, "EUR"), rate(80, "euro"), rate(120, "EUR")],
            },
          ],
        },
      ],
    } as Parameters<typeof normalizeRatesResponse>[0];
    expect(normalizeRatesResponse(response, 1)).toMatchObject({ total: 120, currency: "EUR" });
  });

  it("never matches a candidate without a usable id or coordinates", async () => {
    const http = fakeHttpClient((req) =>
      req.method === "get"
        ? {
            data: [
              { id: "", name: "Motel One Berlin", latitude: 52.5, longitude: 13.33 },
              { id: "lp2", name: "Motel One Berlin", latitude: 152.5, longitude: 13.33 },
            ],
          }
        : sample,
    );
    expect(
      await fetchLiteApiOffer(http, "secret", { currency: "EUR", guestNationality: "de" }, q),
    ).toBeNull();
    expect(http.calls).toHaveLength(1);
  });
});
