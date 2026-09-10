import { describe, expect, it } from "vitest";
import {
  createStarCatalog,
  STAR_COUNT,
  STAR_STRIDE,
  skyProjectionMatrix,
  spaceOpacity,
} from "./globeSpace";

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

  it("fades smoothly out before Mercator and never renders the wrong projection", () => {
    expect(spaceOpacity(0, 1)).toBe(1);
    expect(spaceOpacity(4, 1)).toBe(1);
    expect(spaceOpacity(6, 1)).toBe(0.5);
    expect(spaceOpacity(8, 1)).toBe(0);
    expect(spaceOpacity(12, 1)).toBe(0);
    expect(spaceOpacity(2, 0)).toBe(0);
    expect(spaceOpacity(2, 0.4)).toBe(0.4);
    expect(spaceOpacity(4.001, 1)).toBeCloseTo(1, 6);
    expect(spaceOpacity(7.999, 1)).toBeCloseTo(0, 6);
  });
});

describe("star catalog", () => {
  it("is stable across rebuilds and distributes directions uniformly without polar clustering", () => {
    const stars = createStarCatalog();
    expect(stars).toEqual(createStarCatalog());
    expect(stars.length).toBe(STAR_COUNT * STAR_STRIDE);
    const bands = new Array<number>(10).fill(0);
    for (let i = 0; i < stars.length; i += STAR_STRIDE) {
      expect(Math.hypot(stars[i], stars[i + 1], stars[i + 2])).toBeCloseTo(1, 6);
      bands[Math.min(9, Math.floor((stars[i + 1] + 1) * 5))]++;
    }
    for (const count of bands) {
      expect(count).toBeGreaterThan(STAR_COUNT * 0.08);
      expect(count).toBeLessThan(STAR_COUNT * 0.12);
    }
  });
});
