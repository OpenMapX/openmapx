import { describe, expect, it } from "vitest";
import { otpMode } from "../otp.js";

describe("otpMode", () => {
  it("maps BUS → bus", () => {
    expect(otpMode("BUS")).toBe("bus");
  });

  it("maps RAIL → rail", () => {
    expect(otpMode("RAIL")).toBe("rail");
  });

  it("maps SUBWAY → subway", () => {
    expect(otpMode("SUBWAY")).toBe("subway");
  });

  it("maps TRAM → tram", () => {
    expect(otpMode("TRAM")).toBe("tram");
  });

  it("maps FERRY → ferry", () => {
    expect(otpMode("FERRY")).toBe("ferry");
  });

  it("maps GONDOLA → gondola", () => {
    expect(otpMode("GONDOLA")).toBe("gondola");
  });

  it("maps FUNICULAR → funicular", () => {
    expect(otpMode("FUNICULAR")).toBe("funicular");
  });

  it("maps CABLE_CAR → cable_car", () => {
    expect(otpMode("CABLE_CAR")).toBe("cable_car");
  });

  it("maps MONORAIL → monorail", () => {
    expect(otpMode("MONORAIL")).toBe("monorail");
  });

  it("maps TROLLEYBUS → bus", () => {
    expect(otpMode("TROLLEYBUS")).toBe("bus");
  });

  it("maps COACH → bus", () => {
    expect(otpMode("COACH")).toBe("bus");
  });

  it("maps WALK → walking", () => {
    expect(otpMode("WALK")).toBe("walking");
  });

  it("is case-insensitive: walk → walking", () => {
    expect(otpMode("walk")).toBe("walking");
  });

  it("is case-insensitive: Bus → bus", () => {
    expect(otpMode("Bus")).toBe("bus");
  });

  it("returns bus for unknown mode string", () => {
    expect(otpMode("HOVERCRAFT")).toBe("bus");
  });

  it("returns bus when mode is undefined", () => {
    expect(otpMode(undefined)).toBe("bus");
  });

  it("returns bus for empty string", () => {
    expect(otpMode("")).toBe("bus");
  });
});
