import { describe, expect, it } from "vitest";
import { normalizeRatesResponse, pickBestHotel } from "./liteapi.js";
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
