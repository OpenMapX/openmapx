import { describe, expect, it } from "vitest";
import { configureApiClient } from "../api/client";
import { buildHotelOpenUrl } from "./hotelLink";

describe("buildHotelOpenUrl", () => {
  it("targets the integration open endpoint with all present params", () => {
    configureApiClient({ baseUrl: "http://api.test" });
    const url = buildHotelOpenUrl("booking", {
      name: "Hotel Motel One",
      city: "Berlin",
      countryCode: "de",
      lat: 52.5,
      lng: 13.3,
      checkIn: "2026-05-31",
      checkOut: "2026-06-01",
      adults: 2,
      rooms: 1,
    });
    expect(url).toContain("http://api.test/api/integrations/hotels/booking/open?");
    expect(url).toContain("name=Hotel+Motel+One");
    expect(url).toContain("country=de");
    expect(url).toContain("checkIn=2026-05-31");
    expect(url).toContain("checkOut=2026-06-01");
    expect(url).toContain("adults=2");
    expect(url).toContain("rooms=1");
  });

  it("omits absent optional params", () => {
    configureApiClient({ baseUrl: "http://api.test" });
    const url = buildHotelOpenUrl("agoda", { name: "X" });
    expect(url).toContain("/hotels/agoda/open?name=X");
    expect(url).not.toContain("checkIn=");
    expect(url).not.toContain("country=");
  });
});
