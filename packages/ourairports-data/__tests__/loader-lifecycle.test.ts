import type { Logger } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBackgroundLoad, stopBackgroundLoad } from "../loader.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} satisfies Logger;

describe("OurAirports background-load ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    stopBackgroundLoad();
  });

  afterEach(() => {
    stopBackgroundLoad();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the shared refresh timer alive until every generation owner releases it", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const releaseOldGeneration = startBackgroundLoad(log);
    const releaseNewGeneration = startBackgroundLoad(log);

    releaseOldGeneration();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    releaseNewGeneration();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
