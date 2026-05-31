// integrations/hotels/idResolver.test.ts
import { describe, expect, it } from "vitest";
import { buildExactDeepLink } from "./idResolver.js";

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
