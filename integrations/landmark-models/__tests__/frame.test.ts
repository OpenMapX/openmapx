import { cameraMatrix, type MercatorOrigin, mercatorOrigin, objectMatrix } from "@openmapx/core";
import { nth } from "@openmapx/integration-framework/testing";
import { MercatorCoordinate } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { GLB_TO_SCENE, unprojectRay } from "../web/frame";

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

function multiply(m: ArrayLike<number>, v: Vec4): Vec4 {
  const out: Vec4 = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++)
      out[row] = nth(out, row) + nth(m, col * 4 + row) * nth(v, col);
  return out;
}

function compose(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++)
      for (let k = 0; k < 4; k++)
        out[col * 4 + row] = nth(out, col * 4 + row) + nth(a, k * 4 + row) * nth(b, col * 4 + k);
  return out;
}

const divide = ([x, y, z, w]: Vec4): Vec3 => [x / w, y / w, z / w];

/** The determinant of the upper-left 3×3 block of a column-major 4×4 matrix. */
function determinant3(matrix: ArrayLike<number>): number {
  const m = (i: number) => nth(matrix, i);
  return (
    m(0) * (m(5) * m(10) - m(9) * m(6)) -
    m(4) * (m(1) * m(10) - m(9) * m(2)) +
    m(8) * (m(1) * m(6) - m(5) * m(2))
  );
}

/** A perspective-like matrix from mercator 0..1 space, as MapLibre's mainMatrix is. */
const MAIN: number[] = [
  2.1e5,
  3.3e3,
  1.2e-2,
  1.1e-2,
  -4.2e3,
  1.9e5,
  2.0e-2,
  1.8e-2,
  7.0e2,
  -5.0e2,
  9.0e-1,
  8.9e-1,
  -2.1e5 * 0.5,
  -1.9e5 * 0.34,
  -0.2,
  0.3,
];

const ANCHOR: [number, number] = [2.2945, 48.8584];

function expectedClip(east: number, up: number, south: number): Vec3 {
  const anchor = MercatorCoordinate.fromLngLat(ANCHOR);
  const s = anchor.meterInMercatorCoordinateUnits();
  return divide(multiply(MAIN, [anchor.x + east * s, anchor.y + south * s, up * s, 1]));
}

function actualClip(origin: MercatorOrigin, vertex: Vec3): Vec3 {
  const full = compose(cameraMatrix(MAIN, origin), objectMatrix(ANCHOR, 0, origin, GLB_TO_SCENE));
  return divide(multiply(full, [...vertex, 1]));
}

function close(a: Vec3, b: Vec3) {
  for (let i = 0; i < 3; i++)
    expect(Math.abs(nth(a, i) - nth(b, i))).toBeLessThan(1e-9 * Math.max(1, Math.abs(nth(b, i))));
}

describe("landmark model frame", () => {
  it("maps a vertex 10 m east, 20 m up and 30 m south to the expected clip coordinate", () => {
    const origin = mercatorOrigin(...ANCHOR);
    close(actualClip(origin, [10, 20, 30]), expectedClip(10, 20, 30));
  });

  it("the clip coordinate is origin-independent", () => {
    const near = mercatorOrigin(...ANCHOR);
    const far = mercatorOrigin(2.3075, 48.8644);
    close(actualClip(far, [10, 20, 30]), actualClip(near, [10, 20, 30]));
  });

  it("object matrices are proper rotations", () => {
    const origin = mercatorOrigin(2.3075, 48.8644);
    const det = determinant3(objectMatrix(ANCHOR, 5, origin, GLB_TO_SCENE));
    const k =
      MercatorCoordinate.fromLngLat(ANCHOR).meterInMercatorCoordinateUnits() / origin.metersToUnits;
    expect(det).toBeGreaterThan(0);
    expect(det).toBeCloseTo(k ** 3, 12);
    expect(determinant3(GLB_TO_SCENE)).toBe(1);
  });

  it("unprojectRay passes through the projected point", () => {
    const origin = mercatorOrigin(...ANCHOR);
    const camera = cameraMatrix(MAIN, origin);
    const scenePoint: Vec4 = [12, -7, 25, 1];
    const [nx, ny] = divide(multiply(camera, scenePoint));
    const viewport = { width: 800, height: 600 };
    const pixel = { x: ((nx + 1) / 2) * viewport.width, y: ((1 - ny) / 2) * viewport.height };
    const ray = unprojectRay(camera, pixel, viewport);
    const toPoint: Vec3 = [12 - ray.origin[0], -7 - ray.origin[1], 25 - ray.origin[2]];
    const length = Math.hypot(...toPoint);
    const cos =
      (toPoint[0] * ray.direction[0] +
        toPoint[1] * ray.direction[1] +
        toPoint[2] * ray.direction[2]) /
      length;
    expect(cos).toBeGreaterThan(1 - 1e-9);
  });
});
