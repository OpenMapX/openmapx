import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const watchdog = vi.hoisted(() => ({ stopEventLoopWatchdog: vi.fn() }));
vi.mock("../event-loop-watchdog.js", () => watchdog);

let runtimeDir: string;

beforeEach(() => {
  // The boot marker is module state; each test starts a fresh process's worth.
  vi.resetModules();
  watchdog.stopEventLoopWatchdog.mockClear();
  runtimeDir = mkdtempSync(join(tmpdir(), "omx-process-lifecycle-"));
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe("a stop request during start-up", () => {
  it("marks the stop and stops the watchdog on every signal, also one after the boot began", async () => {
    const { createStartupStopHandler } = await import("../process-lifecycle.js");
    const { beginBoot, markIntegrationLoading, readBootMarker } = await import("../safe-mode.js");
    const exit = vi.fn();
    const log = { warn: vi.fn() };
    const stop = createStartupStopHandler({ cancel: () => new Promise(() => {}), exit, log });

    // A first signal before the boot marker exists has nothing to mark.
    stop.onSignal("SIGTERM");
    beginBoot(runtimeDir, new Date());
    markIntegrationLoading("acme", "import");
    stop.onSignal("SIGTERM");

    expect(readBootMarker(runtimeDir).running).toBe(false);
    expect(watchdog.stopEventLoopWatchdog).toHaveBeenCalledTimes(2);
    expect(stop.requested()).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { signal: "SIGTERM" },
      "Stopping before startup finished",
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)("exits after the migrations are cancelled (%s)", async (signal, code) => {
    const { createStartupStopHandler } = await import("../process-lifecycle.js");
    const exit = vi.fn();
    const stop = createStartupStopHandler({
      cancel: async () => {},
      exit,
      log: { warn: vi.fn() },
    });
    expect(stop.requested()).toBe(false);
    stop.onSignal(signal);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(code));
  });
});
