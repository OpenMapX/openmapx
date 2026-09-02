import { describe, expect, it } from "vitest";
import {
  ChainRequestValidationError,
  MAX_CHAIN_WAYPOINTS,
  parseChainRequest,
} from "../chain-request.js";

const COLOGNE = { lat: 50.94, lng: 6.96 };
const BONN = { lat: 50.73, lng: 7.1 };

describe("parseChainRequest", () => {
  it("parses a minimal body", () => {
    const parsed = parseChainRequest({ waypoints: [COLOGNE, BONN] });
    expect(parsed.waypoints).toEqual([COLOGNE, BONN]);
    expect(parsed.anchor).toEqual({ kind: "now" });
    expect(parsed.schedules).toEqual([null, null]);
    expect(parsed.baseRequest.modes).toEqual(["TRANSIT"]);
  });

  it("rejects fewer than two waypoints", () => {
    expect(() => parseChainRequest({ waypoints: [COLOGNE] })).toThrow(ChainRequestValidationError);
  });

  it("rejects more than the segment cap", () => {
    const many = Array.from({ length: MAX_CHAIN_WAYPOINTS + 1 }, () => COLOGNE);
    expect(() => parseChainRequest({ waypoints: many })).toThrow(/2-8/);
  });

  it("rejects an invalid coordinate", () => {
    expect(() => parseChainRequest({ waypoints: [COLOGNE, { lat: 91, lng: 0 }] })).toThrow(
      /coordinate/i,
    );
  });

  it("rejects a schedules array that does not align", () => {
    expect(() => parseChainRequest({ waypoints: [COLOGNE, BONN], schedules: [null] })).toThrow(
      /one entry per waypoint/,
    );
  });

  it("rejects an unknown schedule field", () => {
    expect(() =>
      parseChainRequest({ waypoints: [COLOGNE, BONN], schedules: [null, { whenever: true }] }),
    ).toThrow(/unknown schedule field/);
  });

  it("rejects departureTime together with arrivalTime", () => {
    expect(() =>
      parseChainRequest({
        waypoints: [COLOGNE, BONN],
        departureTime: "2026-09-01T09:00",
        arrivalTime: "2026-09-01T17:00",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("maps the anchor from whichever time was given", () => {
    expect(
      parseChainRequest({ waypoints: [COLOGNE, BONN], arrivalTime: "2026-09-01T17:00" }).anchor,
    ).toEqual({ kind: "arriveBy", wallClock: "2026-09-01T17:00" });
    expect(
      parseChainRequest({ waypoints: [COLOGNE, BONN], departureTime: "2026-09-01T09:00" }).anchor,
    ).toEqual({ kind: "departAt", wallClock: "2026-09-01T09:00" });
  });

  it("rejects a page token, which has no meaning for a chain", () => {
    expect(() => parseChainRequest({ waypoints: [COLOGNE, BONN], page_token: "abc" })).toThrow(
      /paging/i,
    );
  });

  it("rejects an out-of-range transfer count and an unknown buffer", () => {
    expect(() => parseChainRequest({ waypoints: [COLOGNE, BONN], maxTransfers: 9 })).toThrow(
      /maxTransfers/,
    );
    expect(() =>
      parseChainRequest({ waypoints: [COLOGNE, BONN], transferBuffer: "loose" }),
    ).toThrow(/transferBuffer/);
  });

  it("carries the shared planning preferences through to every segment", () => {
    const parsed = parseChainRequest({
      waypoints: [COLOGNE, BONN],
      modes: ["BUS", "RAIL"],
      wheelchair: true,
      maxTransfers: 2,
      transferBuffer: "relaxed",
      deutschlandticketOnly: true,
    });
    expect(parsed.baseRequest).toMatchObject({
      modes: ["BUS", "RAIL"],
      wheelchair: true,
      wheelchairRequired: true,
      maxTransfers: 2,
      transferBuffer: "relaxed",
      deutschlandticketOnly: true,
    });
  });

  it("clamps the requested itinerary count", () => {
    expect(
      parseChainRequest({ waypoints: [COLOGNE, BONN], numItineraries: 99 }).numItineraries,
    ).toBe(10);
    expect(
      parseChainRequest({ waypoints: [COLOGNE, BONN], numItineraries: 0 }).numItineraries,
    ).toBe(1);
  });
});
