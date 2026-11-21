import { describe, expect, it } from "vitest";
import { hash2, unit } from "../web/derive/hash";

describe("hash", () => {
  it("is a fixed 32-bit unsigned hash of a cell", () => {
    // Pinned: forests and jitter must not move between releases.
    expect([hash2(0, 0), hash2(1, 0), hash2(0, 1), hash2(-7, 123456)]).toEqual(PINNED);
    for (const [i, j] of [
      [0, 0],
      [5, -9],
      [2 ** 20, 2 ** 21],
    ] as const) {
      const h = hash2(i, j);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("derives independent uniform values in [0, 1)", () => {
    const values = Array.from({ length: 10_000 }, (_, i) => unit(hash2(i, 3 * i), 0));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
    const h = hash2(4, 2);
    expect(unit(h, 0)).not.toBe(unit(h, 1));
    expect(unit(h, 1)).toBe(unit(h, 1));
  });

  it("varies with each coordinate", () => {
    const seen = new Set<number>();
    for (let i = -20; i < 20; i++) for (let j = -20; j < 20; j++) seen.add(hash2(i, j));
    expect(seen.size).toBe(1600);
  });
});

const PINNED = [2462723854, 3523150270, 1523537626, 1408550173];
