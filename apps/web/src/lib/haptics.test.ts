import { describe, expect, it, vi } from "vitest";
import { haptics } from "./haptics";

describe("haptics", () => {
  it("calls navigator.vibrate when available", () => {
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate });
    haptics.tap();
    expect(vibrate).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("is a no-op when vibrate is absent", () => {
    vi.stubGlobal("navigator", {});
    expect(() => haptics.warn()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
