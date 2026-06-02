// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWakeLock } from "./useWakeLock";

afterEach(() => vi.unstubAllGlobals());

describe("useWakeLock", () => {
  it("requests a screen wake lock when active", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ release, addEventListener: vi.fn() });
    vi.stubGlobal("navigator", { wakeLock: { request } });
    // jsdom's real `document` defaults to visibilityState "visible"; keep it so
    // testing-library can mount the hook host element.

    renderHook(() => useWakeLock(true));
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("screen");
  });

  it("is a no-op without wakeLock support", () => {
    vi.stubGlobal("navigator", {});
    // Leave jsdom's real `document` in place so testing-library can mount; the
    // hook short-circuits on the missing wakeLock capability before touching it.
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
  });
});
