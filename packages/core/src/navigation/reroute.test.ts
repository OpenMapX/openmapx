import { describe, expect, it } from "vitest";
import { isReroutingTooOften, pruneRerouteTimes } from "./reroute";

describe("pruneRerouteTimes", () => {
  it("drops timestamps older than the window", () => {
    expect(pruneRerouteTimes([10_000, 90_000, 150_000], 200_000, 120_000)).toEqual([
      90_000, 150_000,
    ]);
  });

  it("keeps everything within the window", () => {
    expect(pruneRerouteTimes([0, 50_000, 100_000], 100_000, 120_000)).toEqual([0, 50_000, 100_000]);
  });
});

describe("isReroutingTooOften", () => {
  it("is true once the reroute count reaches the limit", () => {
    expect(isReroutingTooOften([1, 2, 3], 3)).toBe(true);
    expect(isReroutingTooOften([1, 2, 3, 4], 3)).toBe(true);
  });

  it("is false below the limit", () => {
    expect(isReroutingTooOften([1, 2], 3)).toBe(false);
    expect(isReroutingTooOften([], 3)).toBe(false);
  });
});
