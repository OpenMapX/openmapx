import { describe, expect, it } from "vitest";
import { coversFooterCenter } from "./mapFooterCenter";

const footer = { left: 400, right: 1400 };
const box = (left: number, right: number) => ({ left, right, width: right - left });

describe("coversFooterCenter", () => {
  it("leaves the centre free when links and credits sit at opposite ends", () => {
    expect(coversFooterCenter(footer, [box(400, 700), box(1000, 1400)])).toBe(false);
  });

  it("counts footer text that reaches under the legend tab", () => {
    expect(coversFooterCenter(footer, [box(400, 700), box(880, 1400)])).toBe(true);
    expect(coversFooterCenter(footer, [box(400, 1400)])).toBe(true);
  });

  it("ignores empty boxes", () => {
    expect(coversFooterCenter(footer, [{ left: 900, right: 900, width: 0 }])).toBe(false);
  });
});
