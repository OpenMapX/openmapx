import { describe, expect, it } from "vitest";
import { otpRouteColor, otpTransportMode } from "./mapping";

describe("otpTransportMode", () => {
  it.each([
    ["BUS", "bus"],
    ["COACH", "bus"],
    ["TROLLEYBUS", "bus"],
    ["RAIL", "rail"],
    ["SUBWAY", "subway"],
    ["METRO", "subway"],
    ["TRAM", "tram"],
    ["FERRY", "ferry"],
    ["WATER", "ferry"],
    ["GONDOLA", "gondola"],
    ["CABLEWAY", "gondola"],
    ["FUNICULAR", "funicular"],
    ["CABLE_CAR", "cable_car"],
    ["MONORAIL", "monorail"],
    ["WALK", "walking"],
    ["rail", "rail"],
  ])("maps %s to %s", (value, mode) => {
    expect(otpTransportMode(value)).toBe(mode);
  });

  it("leaves an unknown or missing mode undefined", () => {
    expect(otpTransportMode("HOVERCRAFT")).toBeUndefined();
    expect(otpTransportMode(null)).toBeUndefined();
    expect(otpTransportMode("")).toBeUndefined();
  });
});

describe("otpRouteColor", () => {
  it("returns six hex digits without #", () => {
    expect(otpRouteColor("FF0000")).toBe("FF0000");
    expect(otpRouteColor("#00aa00")).toBe("00aa00");
  });

  it("has no colour for an empty value and rejects anything else", () => {
    expect(otpRouteColor(null)).toBeUndefined();
    expect(otpRouteColor("")).toBeUndefined();
    expect(otpRouteColor("red")).toBeNull();
    expect(otpRouteColor("#12345")).toBeNull();
  });
});
