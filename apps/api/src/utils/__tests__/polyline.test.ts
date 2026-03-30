import { decodePolyline } from "@openmapx/core";
import { describe, expect, it } from "vitest";

describe("decodePolyline", () => {
  it("decodes a basic polyline (precision 5) to correct [lng, lat] pairs", () => {
    // Standard Google polyline example: 3 points
    // Encoded: "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
    // Decodes to: [38.5, -120.2], [40.7, -120.95], [43.252, -126.453]
    const coords = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(coords).toHaveLength(3);
    // GeoJSON order: [lng, lat]
    const [lng0, lat0] = coords[0];
    expect(lat0).toBeCloseTo(38.5, 1);
    expect(lng0).toBeCloseTo(-120.2, 1);
  });

  it("returns empty array for empty string", () => {
    expect(decodePolyline("")).toEqual([]);
  });

  it('decodes a single zero point "??" to [[0, 0]]', () => {
    expect(decodePolyline("??")).toEqual([[0, 0]]);
  });

  it("returns coordinates in [lng, lat] order (GeoJSON), not [lat, lng]", () => {
    // First point of the Google example is lat=38.5, lng=-120.2
    // In GeoJSON order the first element is lng (negative), second is lat (positive)
    const [[lng, lat]] = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(lng).toBeLessThan(0); // longitude is negative (western hemisphere)
    expect(lat).toBeGreaterThan(0); // latitude is positive (northern hemisphere)
  });

  it("supports precision 6 (MOTIS polylines) — zero point is unaffected", () => {
    // "??" always decodes to [0, 0] regardless of precision
    expect(decodePolyline("??", 6)).toEqual([[0, 0]]);
  });

  it("produces more precise coordinates with precision 6 vs precision 5", () => {
    // Encode the same string with both precisions — they should differ.
    // Use "_p~iF~ps|U_ulLnnqC_mqNvxq`@": with precision=5 this gives real coords,
    // but with precision=6 the same bytes represent values divided by 1e6 instead of 1e5.
    const p5 = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    const p6 = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 6);
    // Precision 6 divides by 10x more, so values should be 10x smaller (in magnitude)
    expect(Math.abs(p6[0][0])).toBeCloseTo(Math.abs(p5[0][0]) / 10, 1);
    expect(Math.abs(p6[0][1])).toBeCloseTo(Math.abs(p5[0][1]) / 10, 1);
  });

  it("decodes a precision-6 string near Berlin (lat≈52.52, lng≈13.405)", () => {
    // "_cqdcBosdqX" encodes [lat=52.52, lng=13.405] at precision 6
    const coords = decodePolyline("_cqdcBosdqX", 6);
    expect(coords).toHaveLength(1);
    const [lng, lat] = coords[0];
    expect(lat).toBeCloseTo(52.52, 2);
    expect(lng).toBeCloseTo(13.405, 2);
  });
});
