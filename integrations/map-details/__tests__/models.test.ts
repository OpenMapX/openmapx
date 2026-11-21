import {
  type BufferGeometry,
  Color,
  CustomBlending,
  OneFactor,
  SrcColorFactor,
  ZeroFactor,
} from "three";
import { describe, expect, it } from "vitest";
import type { ModelKind } from "../web/derive/forest";
import {
  applyPalette,
  buildModel,
  contactShadowGeometry,
  contactShadowMaterial,
  MATERIAL_ROLES,
  ROLE_COLOURS,
} from "../web/models";

const KINDS: ModelKind[] = ["broadleaf", "conifer", "lamp_arm", "lamp_lantern", "signal", "bench"];
const triangles = (geometry: BufferGeometry) =>
  (geometry.index ? geometry.index.count : (geometry.getAttribute("position")?.count ?? 0)) / 3;
const box = (geometry: BufferGeometry) => {
  geometry.computeBoundingBox();
  return geometry.boundingBox as NonNullable<BufferGeometry["boundingBox"]>;
};

describe("procedural models", () => {
  it.each([
    ["broadleaf", "near", 400],
    ["broadleaf", "far", 80],
    ["conifer", "near", 400],
    ["conifer", "far", 80],
    ["lamp_arm", "near", 200],
    ["lamp_lantern", "near", 200],
    ["signal", "near", 200],
    ["bench", "near", 200],
  ] as const)("keeps %s (%s) within %i triangles", (kind, lod, max) => {
    const geometry = buildModel(kind, lod);
    expect(triangles(geometry)).toBeGreaterThan(4);
    expect(triangles(geometry)).toBeLessThanOrEqual(max);
  });

  it.each(KINDS)("gives every vertex of %s a material role", (kind) => {
    for (const lod of ["near", "far"] as const) {
      const geometry = buildModel(kind, lod);
      const role = geometry.getAttribute("role");
      expect(role.count).toBe(geometry.getAttribute("position").count);
      for (let i = 0; i < role.count; i++) {
        expect(Number.isInteger(role.getX(i))).toBe(true);
        expect(role.getX(i)).toBeGreaterThanOrEqual(0);
        expect(role.getX(i)).toBeLessThan(MATERIAL_ROLES.length);
      }
      expect(geometry.getAttribute("normal").count).toBe(role.count);
    }
  });

  it.each(["broadleaf", "conifer"] as const)(
    "builds a %s one unit tall and one unit wide, standing on z = 0",
    (kind) => {
      for (const lod of ["near", "far"] as const) {
        const { min, max } = box(buildModel(kind, lod));
        expect(min.z).toBeCloseTo(0, 6);
        expect(max.z).toBeCloseTo(1, 2);
        expect(max.x - min.x).toBeLessThanOrEqual(1 + 1e-6);
        expect(max.y - min.y).toBeLessThanOrEqual(1 + 1e-6);
        expect(max.x - min.x).toBeGreaterThan(0.8);
      }
    },
  );

  it("stands the furniture on the ground and points it along +y", () => {
    for (const kind of ["lamp_arm", "lamp_lantern", "signal", "bench"] as const) {
      const { min, max } = box(buildModel(kind, "near"));
      expect(min.z).toBeCloseTo(0, 6);
      expect(max.z).toBeLessThanOrEqual(1 + 1e-6);
    }
    // The arm reaches out over the road, in front (+y) of the pole.
    expect(box(buildModel("lamp_arm", "near")).max.y).toBeGreaterThan(0.15);
  });

  it("switches vertex colours between the day and night palettes, with warm lenses at night", () => {
    const geometry = buildModel("signal", "near");
    applyPalette(geometry, "day");
    const colour = geometry.getAttribute("color");
    const role = geometry.getAttribute("role");
    const lens = MATERIAL_ROLES.indexOf("lens");
    const index = Array.from({ length: role.count }, (_, i) => i).find(
      (i) => role.getX(i) === lens,
    ) as number;
    const day = [colour.getX(index), colour.getY(index), colour.getZ(index)];
    applyPalette(geometry, "night");
    const night = new Color(ROLE_COLOURS.night.lens);
    expect([colour.getX(index), colour.getY(index), colour.getZ(index)]).toEqual([
      expect.closeTo(night.r, 5),
      expect.closeTo(night.g, 5),
      expect.closeTo(night.b, 5),
    ]);
    expect(day).not.toEqual([night.r, night.g, night.b]);
    expect(ROLE_COLOURS.night.lens).toBe(0xffd28a);
    expect(colour.needsUpdate === undefined || typeof colour.version === "number").toBe(true);
  });

  it("darkens with a multiplying contact shadow that keeps the canvas alpha", () => {
    const material = contactShadowMaterial();
    expect(material.blending).toBe(CustomBlending);
    expect(material.blendSrc).toBe(ZeroFactor);
    expect(material.blendDst).toBe(SrcColorFactor);
    expect(material.blendSrcAlpha).toBe(ZeroFactor);
    expect(material.blendDstAlpha).toBe(OneFactor);
    expect(material.depthWrite).toBe(false);
    expect(material.polygonOffset).toBe(true);
    expect(triangles(contactShadowGeometry())).toBe(2);
  });
});
