import { describe, expect, it } from "vitest";
import { nth } from "@/test";
import { createStarCatalog, STAR_COUNT, STAR_STRIDE } from "./starCatalog";

describe("star catalog", () => {
  it("is stable across rebuilds and distributes directions uniformly without polar clustering", () => {
    const stars = createStarCatalog();
    expect(stars).toEqual(createStarCatalog());
    expect(stars.length).toBe(STAR_COUNT * STAR_STRIDE);
    const bands = new Array<number>(10).fill(0);
    for (let i = 0; i < stars.length; i += STAR_STRIDE) {
      expect(Math.hypot(nth(stars, i), nth(stars, i + 1), nth(stars, i + 2))).toBeCloseTo(1, 6);
      const band = Math.min(9, Math.floor((nth(stars, i + 1) + 1) * 5));
      bands[band] = nth(bands, band) + 1;
    }
    for (const count of bands) {
      expect(count).toBeGreaterThan(STAR_COUNT * 0.08);
      expect(count).toBeLessThan(STAR_COUNT * 0.12);
    }
  });
});
