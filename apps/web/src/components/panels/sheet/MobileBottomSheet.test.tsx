import { describe, expect, it } from "vitest";
import { keyboardDetent } from "./MobileBottomSheet";

describe("keyboardDetent", () => {
  it("steps up and down between detents", () => {
    expect(keyboardDetent("ArrowUp", "peek")).toBe("mid");
    expect(keyboardDetent("ArrowUp", "mid")).toBe("full");
    expect(keyboardDetent("ArrowDown", "full")).toBe("mid");
  });

  it("stops at the ends instead of wrapping", () => {
    expect(keyboardDetent("ArrowUp", "full")).toBeNull();
    expect(keyboardDetent("ArrowDown", "peek")).toBeNull();
  });

  it("jumps with Home and End", () => {
    expect(keyboardDetent("Home", "full")).toBe("peek");
    expect(keyboardDetent("End", "peek")).toBe("full");
  });

  it("ignores unrelated keys", () => {
    expect(keyboardDetent("Enter", "mid")).toBeNull();
  });
});
