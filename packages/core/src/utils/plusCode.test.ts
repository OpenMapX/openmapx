import { describe, expect, it } from "vitest";
import type { LngLat } from "../types/geometry";
import { decodePlusCode, decodeShortPlusCode, parsePlusCodeInput } from "./plusCode";

describe("decodeShortPlusCode", () => {
  it.each<[string, string, LngLat, string]>([
    // [name, short code, reference [lng, lat], expected full code]
    // ≈ [0.05006, 51.50006]
    [
      "code east of the 0° meridian, reference west (London)",
      "G322+22",
      [-0.1276, 51.5072],
      "9F32G322+22",
    ],
    // ≈ [-0.05006, 51.50006]
    ["code west of the 0° meridian, reference east", "GW2X+2X", [0.03, 51.5072], "9C3XGW2X+2X"],
    // ≈ [13.40006, 51.97994]
    ["code south of the 52°N edge, reference north", "XCH2+X2", [13.4, 52.02], "9F3MXCH2+X2"],
    // ≈ [13.40006, 52.02006]
    ["code north of the 52°N edge, reference south", "2CC2+22", [13.4, 51.98], "9F4M2CC2+22"],
    // ≈ [20.03006, 49.97994]
    [
      "six-character prefix across both 20° edges (Kraków)",
      "X2X2HJ+X2",
      [19.94, 50.06],
      "8GX2X2HJ+X2",
    ],
    // ≈ [20.03006, 49.97994]
    [
      "four-character prefix across both 1° edges (Kraków)",
      "X2HJ+X2",
      [19.94, 50.06],
      "8GX2X2HJ+X2",
    ],
    // ≈ [-179.94994, -16.79994]
    ["code east of the antimeridian, reference west", "6322+22", [179.9, -16.8], "52M26322+22"],
    // ≈ [179.94994, -16.79994]
    ["code west of the antimeridian, reference east", "6W2X+2X", [-179.9, -16.8], "5VMX6W2X+2X"],
    // ≈ [-179.94994, -16.79994]
    ["unwrapped reference longitude", "6322+22", [539.9, -16.8], "52M26322+22"],
    // ≈ [-1.21769, 51.37006]
    ["same cell, four-character prefix", "9QCJ+2W", [-1.2, 51.4], "9C3W9QCJ+2W"],
    // ≈ [13.40506, 52.52006]
    ["same cell, six-character prefix", "4MGCC4+22", [13.0, 52.0], "9F4MGCC4+22"],
    // ≈ [0.50006, 89.05006]
    ["no shift past the north pole, four-character prefix", "3G22+22", [0.5, 89.9], "CFX23G22+22"],
    // ≈ [0.50006, 71.00006]
    ["no shift past the north pole, six-character prefix", "322G22+22", [0.5, 85.0], "CF322G22+22"],
    // ≈ [0.50006, -89.04994]
    ["no shift past the south pole, four-character prefix", "XG22+22", [0.5, -89.9], "2F22XG22+22"],
  ])("recovers the cell nearest the reference: %s", (_name, short, ref, full) => {
    expect(decodeShortPlusCode(short, ref)).toEqual(decodePlusCode(full));
  });
});

describe("parsePlusCodeInput", () => {
  it("recovers a short code from the map centre across the 0° meridian", () => {
    expect(parsePlusCodeInput("G322+22", [-0.1276, 51.5072])).toEqual({
      lngLat: decodePlusCode("9F32G322+22"),
      label: "G322+22",
    });
  });
});
