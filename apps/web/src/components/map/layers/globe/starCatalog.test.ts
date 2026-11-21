import { describe, expect, it } from "vitest";
import { createStarCatalog, STAR_COUNT, STAR_STRIDE } from "./starCatalog";

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
