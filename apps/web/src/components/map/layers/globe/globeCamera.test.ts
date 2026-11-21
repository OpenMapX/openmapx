import { describe, expect, it } from "vitest";
import {
  cameraPosition,
  invertMatrix,
  skyProjectionMatrix,
  spaceAmount,
  surfaceFade,
} from "./globeCamera";

// Perspective camera looking down -Z. Its off-axis terms represent map padding.
const CAMERA = [2, 0, 0, 0, 0, 3, 0, 0, -0.2, 0.1, -1.01, -1, 40, -25, -500, 501];

function project(matrix: ArrayLike<number>, [x, y, z]: number[]) {
  const w = matrix[2] * x + matrix[5] * y + matrix[8] * z;
  return [
    (matrix[0] * x + matrix[3] * y + matrix[6] * z) / w,
    (matrix[1] * x + matrix[4] * y + matrix[7] * z) / w,
  ];
}

describe("celestial camera", () => {
  it("keeps stars fixed during a dolly, ignoring Earth scale and camera translation", () => {
    const nearEarth = CAMERA.map((value, i) => (i < 12 ? value * 1000 : value * 17));
    const direction = [0.1, 0.2, -1];
    expect(project(skyProjectionMatrix(nearEarth), direction)).toEqual(
      project(skyProjectionMatrix(CAMERA), direction),
    );
  });

  it("preserves perspective, aspect ratio and the off-axis principal point", () => {
    const sky = skyProjectionMatrix(CAMERA);
    const [centerX, centerY] = project(sky, [0, 0, -1]);
    expect(centerX).toBeCloseTo(0.2);
    expect(centerY).toBeCloseTo(-0.1);
    expect(project(sky, [0.1, 0.1, -1])[0]).toBeCloseTo(0.4);
    expect(project(sky, [0.1, 0.1, -1])[1]).toBeCloseTo(0.2);
    // The same lateral direction at half the forward depth lies twice as far
    // from the principal point; this cannot be reproduced with CSS scrolling.
    expect(project(sky, [0.1, 0.1, -0.5])[0]).toBeCloseTo(0.6);
  });

  it("rotates the whole sky with camera bearing and tilt", () => {
    // Compose a 90-degree camera roll with the perspective matrix.
    const rotated = [...CAMERA];
    for (let row = 0; row < 4; row++) {
      rotated[row] = CAMERA[4 + row];
      rotated[4 + row] = -CAMERA[row];
    }
    const [x, y] = project(skyProjectionMatrix(rotated), [0.1, 0, -1]);
    expect(x).toBeCloseTo(0.2);
    expect(y).toBeCloseTo(0.2);

    // A 90-degree tilt makes a direction formerly at the horizon face forward.
    const tilted = [...CAMERA];
    for (let row = 0; row < 4; row++) {
      tilted[4 + row] = CAMERA[8 + row];
      tilted[8 + row] = -CAMERA[4 + row];
    }
    expect(project(skyProjectionMatrix(tilted), [0, -1, 0])[0]).toBeCloseTo(0.2);
  });

  it("has no seam across the antimeridian and returns to the same sky after an orbit", () => {
    const orbit = (angle: number) => {
      const c = Math.cos((angle * Math.PI) / 180);
      const s = Math.sin((angle * Math.PI) / 180);
      const matrix = [...CAMERA];
      for (let row = 0; row < 4; row++) {
        matrix[row] = CAMERA[row] * c + CAMERA[8 + row] * s;
        matrix[8 + row] = -CAMERA[row] * s + CAMERA[8 + row] * c;
      }
      return project(skyProjectionMatrix(matrix), [0.1, 0, 1]);
    };
    expect(orbit(180)[0]).toBeCloseTo(orbit(-180)[0], 12);
    expect(orbit(179.999)[0]).toBeCloseTo(orbit(-179.999)[0], 3);
    expect(orbit(25)[0]).toBeCloseTo(orbit(385)[0], 6);
  });
});

type Mat4 = number[];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}

const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x: number, y: number, z: number): Mat4 => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];
const scale = (s: number): Mat4 => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
function rotate(axis: "x" | "y" | "z", angle: number): Mat4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === "x") return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === "y") return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function perspective(fov: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fov / 2);
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ];
}

const RADIANS = Math.PI / 180;

/** The globe matrix as MapLibre's vertical-perspective transform builds it. */
function globeMatrix(lng: number, lat: number, pitch: number, bearing: number, radius: number) {
  const distance = 1500;
  return [
    perspective(0.6435, 1400 / 900, 0.5, distance + radius * 2),
    translate(0, 0, -distance),
    rotate("x", -pitch * RADIANS),
    rotate("z", bearing * RADIANS),
    translate(0, 0, -radius),
    rotate("x", lat * RADIANS),
    rotate("y", -lng * RADIANS),
    scale(radius),
  ].reduce(multiply, identity());
}

/** MapLibre's own camera-position derivation, for comparison. */
function expectedCamera(lng: number, lat: number, pitch: number, bearing: number, radius: number) {
  const apply = (m: Mat4, [x, y, z]: number[]) => [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
  let p = [0, 0, 1500 / radius];
  p = apply(rotate("x", pitch * RADIANS), p);
  p = apply(rotate("z", -bearing * RADIANS), p);
  p = [p[0], p[1], p[2] + 1];
  p = apply(rotate("x", -lat * RADIANS), p);
  return apply(rotate("y", lng * RADIANS), p);
}

describe("globe camera", () => {
  it("inverts the globe matrix in double precision", () => {
    const matrix = globeMatrix(10, 45, 60, 30, 650);
    const inverse = invertMatrix(matrix);
    expect(inverse).not.toBeNull();
    const product = multiply(matrix, Array.from(inverse as Float64Array));
    for (const [i, value] of identity().entries()) expect(product[i]).toBeCloseTo(value, 6);
  });

  it("rejects a singular matrix", () => {
    expect(invertMatrix(new Array(16).fill(0))).toBeNull();
  });

  it.each([
    [0, 0, 0, 0, 120],
    [10, 45, 60, 30, 650],
    // Pitched towards the horizon at globe zoom: rays graze the limb.
    [-100, -30, 75, -140, 2600],
  ])(
    "finds the camera over (%s, %s) pitched %s° bearing %s°",
    (lng, lat, pitch, bearing, radius) => {
      const inverse = invertMatrix(globeMatrix(lng, lat, pitch, bearing, radius)) as Float64Array;
      const camera = cameraPosition(inverse);
      const expected = expectedCamera(lng, lat, pitch, bearing, radius);
      for (let i = 0; i < 3; i++) {
        expect(Number.isFinite(camera[i])).toBe(true);
        expect(camera[i]).toBeCloseTo(expected[i], 4);
      }
    },
  );
});

describe("zoom fades", () => {
  it("keeps space up to zoom 5 and hands the background back to the theme sky by zoom 8", () => {
    expect(spaceAmount(1, 1)).toBe(1);
    expect(spaceAmount(5, 1)).toBe(1);
    expect(spaceAmount(6.5, 1)).toBe(0.5);
    expect(spaceAmount(8, 1)).toBe(0);
    expect(spaceAmount(12, 1)).toBe(0);
  });

  it("fades the lighting between zoom 5 and 7", () => {
    expect(surfaceFade(5, 1)).toBe(1);
    expect(surfaceFade(6, 1)).toBe(0.5);
    expect(surfaceFade(7, 1)).toBe(0);
  });

  it("never draws over the flat projection", () => {
    expect(spaceAmount(3, 0)).toBe(0);
    expect(surfaceFade(3, 0)).toBe(0);
    expect(spaceAmount(3, 0.4)).toBe(0.4);
    expect(surfaceFade(3, 1.2)).toBe(1);
  });
});
