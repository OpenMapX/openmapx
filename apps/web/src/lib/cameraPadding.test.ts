// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MIN_VISIBLE_PX,
  paddingEquals,
  puckOffsetActive,
  resolveCameraPadding,
} from "./cameraPadding";

const viewport = { width: 1200, height: 800 };
const zero = { top: 0, bottom: 0, left: 0, right: 0 };

describe("resolveCameraPadding", () => {
  it("passes insets through when the visible area stays large", () => {
    expect(
      resolveCameraPadding({
        insets: { ...zero, left: 400, top: 72 },
        viewport,
        puckOffset: false,
      }),
    ).toEqual({ top: 72, bottom: 0, left: 400, right: 0 });
  });

  it("keeps at least 30 % of each axis visible by scaling the pair proportionally", () => {
    const padding = resolveCameraPadding({
      insets: { top: 0, bottom: 0, left: 800, right: 200 },
      viewport: { width: 1000, height: 800 },
      puckOffset: false,
    });
    expect(padding.left + padding.right).toBe(700);
    expect(padding.left / padding.right).toBeCloseTo(4, 5);
  });

  it("never leaves less than MIN_VISIBLE_PX on a tiny viewport", () => {
    const padding = resolveCameraPadding({
      insets: { top: 300, bottom: 300, left: 0, right: 0 },
      viewport: { width: 320, height: 400 },
      puckOffset: false,
    });
    expect(400 - padding.top - padding.bottom).toBeGreaterThanOrEqual(MIN_VISIBLE_PX);
  });

  it("adds the puck offset from the visible height, after clamping", () => {
    const padding = resolveCameraPadding({
      insets: { ...zero, bottom: 200 },
      viewport,
      puckOffset: true,
    });
    expect(padding).toEqual({ top: 300, bottom: 200, left: 0, right: 0 });
  });

  it("treats non-finite or negative insets as zero and a zero viewport as no padding", () => {
    expect(
      resolveCameraPadding({
        insets: { top: Number.NaN, bottom: -5, left: 10, right: 0 },
        viewport,
        puckOffset: false,
      }),
    ).toEqual({ top: 0, bottom: 0, left: 10, right: 0 });
    expect(
      resolveCameraPadding({
        insets: { ...zero, left: 400 },
        viewport: { width: 0, height: 0 },
        puckOffset: true,
      }),
    ).toEqual(zero);
  });

  it("rounds to whole pixels", () => {
    const padding = resolveCameraPadding({
      insets: { ...zero, left: 10.4, right: 10.6 },
      viewport,
      puckOffset: false,
    });
    expect(padding).toEqual({ top: 0, bottom: 0, left: 10, right: 11 });
  });
});

describe("paddingEquals", () => {
  it("compares within tolerance", () => {
    expect(paddingEquals({ ...zero, top: 100 }, { ...zero, top: 100.4 })).toBe(true);
    expect(paddingEquals({ ...zero, top: 100 }, { ...zero, top: 101 })).toBe(false);
  });
});

describe("puckOffsetActive", () => {
  it("is on for ground navigation in follow and free, off for overview, transit, and idle", () => {
    expect(puckOffsetActive({ status: "navigating", kind: "ground", cameraMode: "follow" })).toBe(
      true,
    );
    expect(puckOffsetActive({ status: "rerouting", kind: "ground", cameraMode: "free" })).toBe(
      true,
    );
    expect(puckOffsetActive({ status: "navigating", kind: "ground", cameraMode: "overview" })).toBe(
      false,
    );
    expect(puckOffsetActive({ status: "navigating", kind: "transit", cameraMode: "follow" })).toBe(
      false,
    );
    expect(puckOffsetActive({ status: "idle", kind: "ground", cameraMode: "follow" })).toBe(false);
  });
});
