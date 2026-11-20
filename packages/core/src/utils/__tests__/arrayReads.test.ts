import { describe, expect, it } from "vitest";
import { indexAt } from "../indexAt";
import { numberAt } from "../numberAt";

describe("numberAt", () => {
  it("reads stored numbers and NaN outside the array", () => {
    const values = new Float64Array([1.5, -2]);
    expect(numberAt(values, 1)).toBe(-2);
    expect(numberAt(values, 2)).toBeNaN();
    expect(numberAt([3], -1)).toBeNaN();
  });
});

describe("indexAt", () => {
  it("reads stored indices, including the negative no-child marker", () => {
    expect(indexAt(new Int32Array([4, -1]), 0)).toBe(4);
    expect(indexAt(new Int32Array([4, -1]), 1)).toBe(-1);
    expect(indexAt([0, 7], 1)).toBe(7);
  });

  it("throws instead of returning a value that would end no loop", () => {
    expect(() => indexAt(new Int32Array(2), 2)).toThrow(RangeError);
    expect(() => indexAt([1], Number.NaN)).toThrow("No index stored at position NaN of 1");
  });
});
