// integrations/hotels/providers.test.ts
import { describe, expect, it } from "vitest";
import { getHotelProvider, HOTEL_PROVIDERS, providerServes } from "./providers.js";
import type { HotelQuery } from "./types.js";

function throwMissing(id: string): never {
  throw new Error(`missing provider ${id}`);
}

const q: HotelQuery = {
  name: "Hotel Motel One Berlin",
  city: "Berlin",
  countryCode: "de",
  lat: 52.5,
  lng: 13.33,
  checkIn: "2026-05-31",
  checkOut: "2026-06-01",
  adults: 2,
  rooms: 1,
};

describe("hotel providers", () => {
  it("booking link carries ss, dates, occupancy, geo", () => {
    const p = getHotelProvider("booking");
    expect(p).toBeDefined();
    const url = p!.build(q, {});
    expect(url).toContain("https://www.booking.com/searchresults.html?");
    expect(url).toContain("checkin=2026-05-31");
    expect(url).toContain("checkout=2026-06-01");
    expect(url).toContain("group_adults=2");
    expect(url).toContain("no_rooms=1");
    expect(url).toContain("latitude=52.5");
  });

  it("booking aid is appended when configured", () => {
    const url = getHotelProvider("booking")!.build(q, { bookingAid: "123456" });
    expect(url).toContain("aid=123456");
  });

  it("expedia uses Hotel-Search with dates + occupancy", () => {
    const url = getHotelProvider("expedia")!.build(q, {});
    expect(url).toContain("https://www.expedia.com/Hotel-Search?");
    expect(url).toContain("startDate=2026-05-31");
    expect(url).toContain("endDate=2026-06-01");
    expect(url).toContain("adults=2");
    expect(url).toContain("rooms=1");
  });

  it("affiliate template wraps the destination URL", () => {
    const url = getHotelProvider("expedia")!.build(q, {
      affiliateTemplates: { expedia: "https://go.aff/?u={url}" },
    });
    expect(url.startsWith("https://go.aff/?u=")).toBe(true);
    expect(url).toContain(encodeURIComponent("https://www.expedia.com/Hotel-Search"));
  });

  it("booking is global; hrs is removed", () => {
    expect(providerServes(getHotelProvider("booking") ?? throwMissing("booking"), "us")).toBe(true);
    expect(getHotelProvider("hrs")).toBeUndefined();
  });

  it("no country known ⇒ every provider passes the filter", () => {
    for (const p of HOTEL_PROVIDERS) expect(providerServes(p, undefined)).toBe(true);
  });

  it("id-only OTAs are flagged exactOnly; booking is not", () => {
    for (const id of ["expedia", "hotelscom", "agoda", "tripcom"]) {
      expect(getHotelProvider(id)?.exactOnly).toBe(true);
    }
    expect(getHotelProvider("booking")?.exactOnly).toBeFalsy();
  });
});
