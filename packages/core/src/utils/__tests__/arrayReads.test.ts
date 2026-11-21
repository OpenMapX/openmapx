import { describe, expect, it } from "vitest";
import { indexAt } from "../indexAt";
import { itemAt } from "../itemAt";
import { numberAt } from "../numberAt";

describe("itemAt", () => {
  it("reads present elements of arrays and array-likes", () => {
    expect(itemAt(["a", "b"], 1)).toBe("b");
    expect(itemAt({ length: 1, 0: null }, 0)).toBeNull();
  });

  it("throws for a missing or negative position instead of reading from the end", () => {
    expect(() => itemAt([], 0)).toThrow("No item at position 0 of 0");
    expect(() => itemAt(["a"], -1)).toThrow(RangeError);
  });

  it("names what is missing when the caller says what the element is", () => {
    expect(() => itemAt([], 0, "migration table row")).toThrow(
      "No migration table row at position 0 of 0",
    );
  });
});

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
