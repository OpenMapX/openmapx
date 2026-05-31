// integrations/hotels/query.test.ts
import { describe, expect, it } from "vitest";
import { parseHotelQuery } from "./query.js";

describe("parseHotelQuery", () => {
  it("requires a name", () => {
    const r = parseHotelQuery({});
    expect(r.ok).toBe(false);
  });

  it("parses a full query", () => {
    const r = parseHotelQuery({
      name: "Hotel Motel One",
      city: "Berlin",
      country: "DE",
      lat: "52.5",
      lng: "13.3",
      checkIn: "2026-05-31",
      checkOut: "2026-06-01",
      adults: "2",
      rooms: "1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.countryCode).toBe("de");
      expect(r.query.checkIn).toBe("2026-05-31");
      expect(r.query.adults).toBe(2);
      expect(r.query.rooms).toBe(1);
    }
  });

  it("drops malformed dates and out-of-range occupancy", () => {
    const r = parseHotelQuery({ name: "X", checkIn: "31-05-2026", adults: "0", rooms: "99" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.checkIn).toBeUndefined();
      expect(r.query.adults).toBeUndefined(); // 0 is invalid
      expect(r.query.rooms).toBe(8); // clamped to max
    }
    const r2 = parseHotelQuery({ name: "X", checkIn: "2026-13-99", checkOut: "2026-02-31" });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.query.checkIn).toBeUndefined();
      expect(r2.query.checkOut).toBeUndefined();
    }
  });

  it("accepts a valid wikidata qid and rejects a malformed one", () => {
    const ok = parseHotelQuery({ name: "X", wikidata: "Q12231151" });
    expect(ok.ok && ok.query.wikidata).toBe("Q12231151");
    const bad = parseHotelQuery({ name: "X", wikidata: "12231151" });
    expect(bad.ok && bad.query.wikidata).toBeUndefined();
  });
});
