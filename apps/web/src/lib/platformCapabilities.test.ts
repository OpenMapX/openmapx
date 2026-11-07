import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

import { hasCapability } from "./platformCapabilities";

describe("hasCapability", () => {
  it("returns false in a non-DOM environment for hardware features", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);
    expect(hasCapability("wakeLock")).toBe(false);
  });
});
