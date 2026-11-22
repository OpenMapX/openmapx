import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { cumulativeDistances } from "../deadReckon";
import {
  approachTargetZoom,
  junctionFitZoom,
  lookAheadBearing,
  lookAheadMeters,
  NAV_CAMERA_PROFILE,
  speedZoom,
} from "../navCameraFraming";

// ~1 m of latitude is 1/111_195 degrees; at the equator longitude matches.
const M = 1 / 111_195;

// Straight north for 100 m, then east for 100 m.
const lShape: LngLat[] = [
  [0, 0],
  [0, 100 * M],
  [100 * M, 100 * M],
];
const lShapeCum = cumulativeDistances(lShape);

// 200 m straight east.
const straightEast: LngLat[] = [
  [0, 0],
  [200 * M, 0],
];
const eastCum = cumulativeDistances(straightEast);

const viewport = { width: 400, height: 800 };
const noPadding = { top: 0, bottom: 0, left: 0, right: 0 };

function mercX(lng: number): number {
  return (lng + 180) / 360;
}
function mercY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

describe("navCameraFraming", () => {
  it("clamps the look-ahead distance", () => {
    expect(lookAheadMeters(0)).toBe(25);
    expect(lookAheadMeters(14)).toBeCloseTo(42);
    expect(lookAheadMeters(60)).toBe(150);
    expect(lookAheadMeters(-3)).toBe(25);
  });

  it("aims at the bend ahead, not the local segment", () => {
    // At 80 m the local segment points north (0°); 42 m ahead lies 22 m east.
    const bearing = lookAheadBearing(lShape, lShapeCum, 80, 42);
    expect(bearing).not.toBeNull();
    expect(bearing ?? 0).toBeGreaterThan(20);
    expect(bearing ?? 0).toBeLessThan(90);
  });

  it("aims no further than a limit, such as the junction of an upcoming turn", () => {
    // Limited to 90 m, the target stays on the northbound leg.
    expect(lookAheadBearing(lShape, lShapeCum, 80, 42, 90)).toBeCloseTo(0, 0);
    // Within 2 m of the limit there is nothing to aim at: the caller keeps the local bearing.
    expect(lookAheadBearing(lShape, lShapeCum, 89, 42, 90)).toBeNull();
    // A limit behind the position is ignored.
    expect(lookAheadBearing(lShape, lShapeCum, 80, 42, 50)).toBeGreaterThan(20);
  });

  it("aims at the final point when the route ends inside the look-ahead", () => {
    expect(lookAheadBearing(straightEast, eastCum, 190, 42)).toBeCloseTo(90, 0);
  });

  it("returns null on the last 5 m", () => {
    expect(lookAheadBearing(straightEast, eastCum, 197, 42)).toBeNull();
  });

  it("fits at pitch 0 like the flat Web Mercator bounding-box zoom", () => {
    // Legs 200 m east-west through the centre; the 400 px width binds.
    const legs: LngLat[] = [
      [-100 * M, 0],
      [100 * M, 0],
    ];
    const span = mercX(100 * M) - mercX(-100 * M);
    const oracle = Math.log2(400 / (span * 512));
    const zoom = junctionFitZoom({
      legs,
      center: [0, 0],
      bearing: 0,
      pitch: 0,
      viewport,
      padding: noPadding,
      maxZoom: 22,
    });
    expect(zoom).toBeCloseTo(oracle, 1);
    expect(zoom).toBeLessThanOrEqual(oracle + 1e-9);
  });

  it("honours padding on the binding side", () => {
    const legs: LngLat[] = [
      [0, 100 * M],
      [0, -100 * M],
    ];
    const span = mercY(-100 * M) - mercY(100 * M);
    const oracle = Math.log2(400 / (span * 512));
    const zoom = junctionFitZoom({
      legs,
      center: [0, 0],
      bearing: 0,
      pitch: 0,
      viewport,
      padding: { top: 300, bottom: 100, left: 0, right: 0 },
      maxZoom: 22,
    });
    expect(zoom).toBeCloseTo(oracle, 1);
  });

  it("longer legs or a steeper pitch never fit at a higher zoom", () => {
    const base = {
      center: [0, 0] as LngLat,
      bearing: 0,
      viewport,
      padding: { top: 200, bottom: 100, left: 20, right: 20 },
      maxZoom: 18,
    };
    const shortLegs: LngLat[] = [
      [0, -40 * M],
      [0, 0],
      [40 * M, 0],
    ];
    const longLegs: LngLat[] = [
      [0, -120 * M],
      [0, 0],
      [120 * M, 0],
    ];
    expect(junctionFitZoom({ ...base, legs: longLegs, pitch: 55 })).toBeLessThanOrEqual(
      junctionFitZoom({ ...base, legs: shortLegs, pitch: 55 }),
    );
    // A point ahead of the centre is foreshortened by pitch, so a tilted camera
    // fits it at a zoom no lower than a flat one (that is why tilt shows more road).
    const ahead: LngLat[] = [[0, 300 * M]];
    expect(junctionFitZoom({ ...base, legs: ahead, pitch: 68 })).toBeGreaterThan(
      junctionFitZoom({ ...base, legs: ahead, pitch: 0 }),
    );
    // A point far behind the centre does not fit at the cap.
    const behind: LngLat[] = [[0, -5000 * M]];
    expect(junctionFitZoom({ ...base, legs: behind, pitch: 68, maxZoom: 18 })).toBeLessThan(18);
  });

  it("never returns more than maxZoom", () => {
    expect(
      junctionFitZoom({
        legs: [[0, 0]],
        center: [0, 0],
        bearing: 0,
        pitch: 60,
        viewport,
        padding: noPadding,
        maxZoom: 17.5,
      }),
    ).toBe(17.5);
  });

  it("frames between the speed zoom and the cap", () => {
    expect(approachTargetZoom(15.7, 16.4, 17.5)).toBeCloseTo(16.4);
    expect(approachTargetZoom(15.7, 19, 17.5)).toBe(17.5);
    expect(approachTargetZoom(16, 15, 17.5)).toBe(16);
  });

  it("matches the spec's speed zoom curves", () => {
    expect(speedZoom(13.9, "2d")).toBeCloseTo(15.74, 1);
    expect(speedZoom(13.9, "3d")).toBeCloseTo(16.62, 1);
    expect(speedZoom(33.3, "3d")).toBe(15);
    expect(speedZoom(0, "3d")).toBe(17.8);
    expect(speedZoom(0, "2d")).toBe(17);
    expect(speedZoom(50, "2d")).toBe(14);
    expect(speedZoom(-1, "2d")).toBe(17);
  });

  it("pins the camera profiles", () => {
    expect(NAV_CAMERA_PROFILE["2d"]).toEqual({
      drivingPitch: 55,
      approachPitch: 60,
      approachZoomCap: 17.5,
      maxPitch: 60,
    });
    expect(NAV_CAMERA_PROFILE["3d"]).toEqual({
      drivingPitch: 62,
      approachPitch: 68,
      approachZoomCap: 18,
      maxPitch: 70,
    });
  });
});
