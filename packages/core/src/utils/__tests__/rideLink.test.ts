import { describe, expect, it } from "vitest";
import { buildRideOpenUrl, rideQuoteBody } from "../rideLink";

const request = {
  pickup: [13.405, 52.52] as [number, number],
  dropoff: [13.377, 52.516] as [number, number],
  pickupAddress: "Alexanderplatz",
  passengers: 2,
  route: { distanceMeters: 4200, durationSeconds: 720 },
};

describe("buildRideOpenUrl", () => {
  it("targets the backend redirect for the given provider", () => {
    const url = new URL(buildRideOpenUrl("uber", request), "http://x");
    expect(url.pathname).toBe("/api/integrations/ride-hailing/uber/open");
    expect(url.searchParams.get("pickupLat")).toBe("52.52");
    expect(url.searchParams.get("dropoffLng")).toBe("13.377");
    expect(url.searchParams.get("passengers")).toBe("2");
  });

  it("omits absent optional fields entirely", () => {
    const url = new URL(buildRideOpenUrl("bolt", { pickup: [13.405, 52.52] }), "http://x");
    expect(url.searchParams.has("dropoffLat")).toBe(false);
    expect(url.searchParams.has("pickupAt")).toBe(false);
    expect(url.searchParams.has("routeDistanceMeters")).toBe(false);
  });

  it("percent-encodes a provider id", () => {
    expect(buildRideOpenUrl("a/b", { pickup: [0, 0] })).toContain("/a%2Fb/open");
  });
});

describe("rideQuoteBody", () => {
  it("flattens the request and carries the provider ids", () => {
    expect(rideQuoteBody(request, ["uber"])).toEqual({
      pickupLat: "52.52",
      pickupLng: "13.405",
      dropoffLat: "52.516",
      dropoffLng: "13.377",
      pickupAddress: "Alexanderplatz",
      passengers: "2",
      routeDistanceMeters: "4200",
      routeDurationSeconds: "720",
      providerIds: ["uber"],
    });
  });
});
