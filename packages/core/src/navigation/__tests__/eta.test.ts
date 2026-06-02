import { describe, expect, it } from "vitest";
import { eta } from "../eta";

describe("eta", () => {
  it("adds remaining seconds (as ms) to now", () => {
    expect(eta(120, 1_000_000)).toBe(1_000_000 + 120_000);
  });
});
