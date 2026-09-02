import { describe, expect, it } from "vitest";
import {
  CAMERA_BEARING_EPSILON,
  CAMERA_LNGLAT_EPSILON,
  CAMERA_ZOOM_EPSILON,
  cameraPoseChanged,
  PUCK_BEARING_EPSILON,
  PUCK_LNGLAT_EPSILON,
  puckPoseChanged,
  SETTLED_FRAMES_BEFORE_SLEEP,
  shouldKeepAnimating,
} from "./navCameraScheduler";

const pose = (lng: number, lat: number, bearing: number) => ({ lng, lat, bearing });
const cam = (lng: number, lat: number, bearing: number, zoom: number) => ({
  lng,
  lat,
  bearing,
  zoom,
});

describe("puckPoseChanged", () => {
  it("treats a never-published pose as changed", () => {
    expect(puckPoseChanged(null, pose(0, 0, 0))).toBe(true);
  });

  it("ignores drift below the puck threshold", () => {
    const last = pose(13.4, 52.5, 90);
    expect(puckPoseChanged(last, pose(13.4 + PUCK_LNGLAT_EPSILON / 2, 52.5, 90))).toBe(false);
    expect(puckPoseChanged(last, pose(13.4, 52.5 + PUCK_LNGLAT_EPSILON / 2, 90))).toBe(false);
    expect(puckPoseChanged(last, pose(13.4, 52.5, 90 + PUCK_BEARING_EPSILON / 2))).toBe(false);
  });

  it("reports movement past the threshold on any axis", () => {
    const last = pose(13.4, 52.5, 90);
    expect(puckPoseChanged(last, pose(13.4 + 1e-8, 52.5, 90))).toBe(true);
    expect(puckPoseChanged(last, pose(13.4, 52.5 - 1e-8, 90))).toBe(true);
    expect(puckPoseChanged(last, pose(13.4, 52.5, 90.001))).toBe(true);
  });

  it("publishes the metre-scale movement one frame of walking produces", () => {
    // ~1.4 m/s over a 16 ms frame is ~0.02 m, an order below the camera's own
    // threshold — the puck still has to track it frame by frame.
    const last = pose(13.4, 52.5, 90);
    expect(puckPoseChanged(last, pose(13.4 + 2e-7, 52.5, 90))).toBe(true);
    expect(
      cameraPoseChanged({ ...last, zoom: 16 }, { ...pose(13.4 + 2e-7, 52.5, 90), zoom: 16 }, true),
    ).toBe(false);
  });

  it("measures rotation along the shortest arc across north", () => {
    expect(puckPoseChanged(pose(0, 0, 359.99999), pose(0, 0, 0.0))).toBe(false);
    expect(puckPoseChanged(pose(0, 0, 359.5), pose(0, 0, 0.5))).toBe(true);
  });
});

describe("cameraPoseChanged", () => {
  it("ignores sub-pixel centre and bearing drift", () => {
    const last = cam(13.4, 52.5, 90, 16);
    expect(cameraPoseChanged(last, cam(13.4 + CAMERA_LNGLAT_EPSILON / 2, 52.5, 90, 16), true)).toBe(
      false,
    );
    expect(
      cameraPoseChanged(last, cam(13.4, 52.5, 90 + CAMERA_BEARING_EPSILON / 2, 16), true),
    ).toBe(false);
    expect(cameraPoseChanged(last, cam(13.4 + 2e-6, 52.5, 90, 16), true)).toBe(true);
  });

  it("ignores a sub-threshold zoom drift while commanding zoom", () => {
    const last = cam(0, 0, 0, 16);
    expect(cameraPoseChanged(last, cam(0, 0, 0, 16 + CAMERA_ZOOM_EPSILON / 2), true)).toBe(false);
    expect(cameraPoseChanged(last, cam(0, 0, 0, 16.05), true)).toBe(true);
  });

  it("never moves the camera for zoom alone once the user owns zoom", () => {
    const last = cam(0, 0, 0, 16);
    expect(cameraPoseChanged(last, cam(0, 0, 0, 18), false)).toBe(false);
    expect(cameraPoseChanged(last, cam(1e-5, 0, 0, 18), false)).toBe(true);
  });
});

describe("cameraPoseChanged with padding", () => {
  const base = { lng: 0, lat: 0, bearing: 0, zoom: 16 };
  const p = (top: number, bottom = 0, left = 0, right = 0) => ({ top, bottom, left, right });
  it("publishes when padding moves by more than half a pixel and not otherwise", () => {
    expect(
      cameraPoseChanged({ ...base, padding: p(100) }, { ...base, padding: p(100.4) }, false),
    ).toBe(false);
    expect(
      cameraPoseChanged({ ...base, padding: p(100) }, { ...base, padding: p(101) }, false),
    ).toBe(true);
    expect(cameraPoseChanged({ ...base }, { ...base, padding: p(1) }, false)).toBe(true);
  });

  it("watches all four edges", () => {
    const last = { ...base, padding: p(100, 80, 60, 40) };
    expect(cameraPoseChanged(last, { ...base, padding: p(101, 80, 60, 40) }, false)).toBe(true);
    expect(cameraPoseChanged(last, { ...base, padding: p(100, 81, 60, 40) }, false)).toBe(true);
    expect(cameraPoseChanged(last, { ...base, padding: p(100, 80, 61, 40) }, false)).toBe(true);
    expect(cameraPoseChanged(last, { ...base, padding: p(100, 80, 60, 41) }, false)).toBe(true);
    expect(cameraPoseChanged(last, { ...base, padding: p(100.4, 80.4, 60.4, 40.4) }, false)).toBe(
      false,
    );
  });
});

describe("shouldKeepAnimating", () => {
  const frame = (over: Partial<Parameters<typeof shouldKeepAnimating>[0]> = {}) =>
    shouldKeepAnimating({
      publishedThisFrame: false,
      settledFrames: SETTLED_FRAMES_BEFORE_SLEEP,
      holdUntilMs: 0,
      nowMs: 1000,
      ...over,
    });

  it("keeps running while anything was published", () => {
    expect(frame({ publishedThisFrame: true })).toBe(true);
  });

  it("keeps running inside a hold window even with nothing to publish", () => {
    expect(frame({ holdUntilMs: 1001 })).toBe(true);
    expect(frame({ holdUntilMs: 1000 })).toBe(false);
  });

  it("needs two settled frames before it sleeps", () => {
    expect(frame({ settledFrames: 1 })).toBe(true);
    expect(frame({ settledFrames: 2 })).toBe(false);
  });
});
