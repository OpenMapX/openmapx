import { describe, expect, it, vi } from "vitest";
import { isConnectivityFailure, readNavigationConnectivity } from "./navigationConnectivity";

describe("navigation connectivity", () => {
  it("reads navigator.onLine false as offline", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(readNavigationConnectivity()).toBe("offline");
    vi.unstubAllGlobals();
  });

  it("reads an available browser as online", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(readNavigationConnectivity()).toBe("online");
    vi.unstubAllGlobals();
  });

  it("classifies browser network failures but not HTTP failures", () => {
    expect(isConnectivityFailure(new TypeError("Failed to fetch"), "online")).toBe(true);
    expect(isConnectivityFailure(new Error("HTTP 503"), "online")).toBe(false);
    expect(isConnectivityFailure(new Error("anything"), "offline")).toBe(true);
  });
});
