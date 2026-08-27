import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../registry.js";

describe("dynamic transit registry refresh ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    registry.stopRefresh();
  });

  afterEach(() => {
    registry.stopRefresh();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps one shared timer until every generation owner releases it", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const releaseOldGeneration = registry.startRefresh();
    const releaseNewGeneration = registry.startRefresh();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    releaseOldGeneration();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    releaseNewGeneration();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
