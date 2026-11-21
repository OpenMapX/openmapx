import { describe, expect, it } from "vitest";
import { nth } from "./nth";

describe("nth", () => {
  it("reads like Array.prototype.at, for arrays and other array-likes", () => {
    const values = ["a", "b", "c"];
    expect(nth(values, 0)).toBe("a");
    expect(nth(values, -1)).toBe("c");
    expect(nth(values, 1.7)).toBe(values.at(1.7));
    expect(nth(new Float32Array([1, 2]), -2)).toBe(1);
  });

  it("throws a RangeError when there is no element", () => {
    expect(() => nth(["a"], 1)).toThrow(RangeError);
    expect(() => nth(["a"], -2)).toThrow(RangeError);
    expect(() => nth([], 0)).toThrow("no element at 0 of 0");
  });
});
