import { describe, expect, it } from "vitest";
import { platformChanged } from "./platform";

describe("platformChanged", () => {
  it("reports a move to another platform", () => {
    expect(platformChanged("2", "4")).toBe(true);
    expect(platformChanged("1 A-C", "2 A-C")).toBe(true);
    expect(platformChanged("10", "1")).toBe(true);
  });

  it("doesn't report the platform's sections being added or dropped", () => {
    expect(platformChanged("10", "10 A-B")).toBe(false);
    expect(platformChanged("10 A-B", "10")).toBe(false);
  });

  it("doesn't report a change without both platforms", () => {
    expect(platformChanged(undefined, "4")).toBe(false);
    expect(platformChanged("2", undefined)).toBe(false);
    expect(platformChanged("2", " 2 ")).toBe(false);
  });
});
