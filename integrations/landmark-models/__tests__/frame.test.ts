import { MercatorCoordinate } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { cameraMatrix, GLB_TO_SCENE, objectMatrix, unprojectRay } from "../web/frame";

type Vec4 = [number, number, number, number];

function multiply(m: ArrayLike<number>, v: Vec4): Vec4 {
  const out: Vec4 = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) out[row] += (m[col * 4 + row] as number) * v[col];
  return out;
}

function compose(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++)
      for (let k = 0; k < 4; k++)
        out[col * 4 + row] += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
  return out;
}

const divide = ([x, y, z, w]: Vec4) => [x / w, y / w, z / w];

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

function expectedClip(east: number, up: number, south: number): number[] {
  const anchor = MercatorCoordinate.fromLngLat(ANCHOR);
  const s = anchor.meterInMercatorCoordinateUnits();
  return divide(multiply(MAIN, [anchor.x + east * s, anchor.y + south * s, up * s, 1]));
}

function actualClip(origin: MercatorCoordinate, vertex: [number, number, number]): number[] {
  const full = compose(cameraMatrix(MAIN, origin), objectMatrix(ANCHOR, 0, origin));
  return divide(multiply(full, [...vertex, 1] as Vec4));
}

function close(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++)
    expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThan(
      1e-9 * Math.max(1, Math.abs(b[i] as number)),
    );
}

describe("landmark model frame", () => {
  it("maps a vertex 10 m east, 20 m up and 30 m south to the expected clip coordinate", () => {
    const origin = MercatorCoordinate.fromLngLat(ANCHOR);
    close(actualClip(origin, [10, 20, 30]), expectedClip(10, 20, 30));
  });

  it("the clip coordinate is origin-independent", () => {
    const near = MercatorCoordinate.fromLngLat(ANCHOR);
    const far = MercatorCoordinate.fromLngLat([2.3075, 48.8644]);
    close(actualClip(far, [10, 20, 30]), actualClip(near, [10, 20, 30]));
  });

  it("object matrices are proper rotations", () => {
    const origin = MercatorCoordinate.fromLngLat([2.3075, 48.8644]);
    const m = objectMatrix(ANCHOR, 5, origin);
    const det =
      (m[0] as number) *
        ((m[5] as number) * (m[10] as number) - (m[9] as number) * (m[6] as number)) -
      (m[4] as number) *
        ((m[1] as number) * (m[10] as number) - (m[9] as number) * (m[2] as number)) +
      (m[8] as number) *
        ((m[1] as number) * (m[6] as number) - (m[5] as number) * (m[2] as number));
    const k =
      MercatorCoordinate.fromLngLat(ANCHOR).meterInMercatorCoordinateUnits() /
      origin.meterInMercatorCoordinateUnits();
    expect(det).toBeGreaterThan(0);
    expect(det).toBeCloseTo(k ** 3, 12);
    const r = GLB_TO_SCENE;
    expect(
      (r[0] as number) *
        ((r[5] as number) * (r[10] as number) - (r[9] as number) * (r[6] as number)) -
        (r[4] as number) *
          ((r[1] as number) * (r[10] as number) - (r[9] as number) * (r[2] as number)) +
        (r[8] as number) *
          ((r[1] as number) * (r[6] as number) - (r[5] as number) * (r[2] as number)),
    ).toBe(1);
  });

  it("unprojectRay passes through the projected point", () => {
    const origin = MercatorCoordinate.fromLngLat(ANCHOR);
    const camera = cameraMatrix(MAIN, origin);
    const scenePoint: Vec4 = [12, -7, 25, 1];
    const [nx, ny] = divide(multiply(camera, scenePoint)) as [number, number, number];
    const viewport = { width: 800, height: 600 };
    const pixel = { x: ((nx + 1) / 2) * viewport.width, y: ((1 - ny) / 2) * viewport.height };
    const ray = unprojectRay(camera, pixel, viewport);
    const toPoint = [12 - ray.origin[0], -7 - ray.origin[1], 25 - ray.origin[2]];
    const length = Math.hypot(...toPoint);
    const cos =
      (toPoint[0] * ray.direction[0] +
        toPoint[1] * ray.direction[1] +
        toPoint[2] * ray.direction[2]) /
      length;
    expect(cos).toBeGreaterThan(1 - 1e-9);
  });
});
