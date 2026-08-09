import { describe, expect, it } from "vitest";
import { parseRideQuery } from "./query.js";

describe("parseRideQuery", () => {
  it("requires a pickup", () => {
    const r = parseRideQuery({});
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-range coordinates", () => {
    const r = parseRideQuery({ pickupLat: "91", pickupLng: "13.4" });
    expect(r.ok).toBe(false);
  });

  it("parses a pickup-only request", () => {
    const r = parseRideQuery({ pickupLat: "52.52", pickupLng: "13.405" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.pickup).toEqual([13.405, 52.52]);
      expect(r.request.dropoff).toBeUndefined();
    }
  });

  it("parses a full request", () => {
    const r = parseRideQuery({
      pickupLat: "52.52",
      pickupLng: "13.405",
      dropoffLat: "52.516",
      dropoffLng: "13.377",
      pickupAddress: "Alexanderplatz",
      passengers: "3",
      pickupAt: "2026-08-09T18:30",
      routeDistanceMeters: "4200",
      routeDurationSeconds: "720",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.dropoff).toEqual([13.377, 52.516]);
      expect(r.request.passengers).toBe(3);
      expect(r.request.route).toEqual({ distanceMeters: 4200, durationSeconds: 720 });
    }
  });

  it("clamps passengers to a sane range", () => {
    const r = parseRideQuery({ pickupLat: "0", pickupLng: "0", passengers: "99" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.passengers).toBe(8);
  });

  it("rejects a malformed pickupAt", () => {
    const r = parseRideQuery({ pickupLat: "0", pickupLng: "0", pickupAt: "tomorrow" });
    expect(r.ok).toBe(false);
  });

  it("drops a half-supplied route", () => {
    const r = parseRideQuery({ pickupLat: "0", pickupLng: "0", routeDistanceMeters: "4200" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.route).toBeUndefined();
  });
});
