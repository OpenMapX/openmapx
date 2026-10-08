import { describe, expect, it, vi } from "vitest";
import { DataManagerReadiness } from "../src/readiness.js";
import { initializeRequiredSubsystems } from "../src/startup.js";

function handles() {
  return { stop: vi.fn() };
}

describe("initializeRequiredSubsystems", () => {
  it("initializes mandatory dependencies in order and returns scheduler handles", async () => {
    const calls: string[] = [];
    const readiness = new DataManagerReadiness();
    const cronHandles = handles();

    const result = await initializeRequiredSubsystems({
      readiness,
      initializeOfflineStorage: async () => {
        calls.push("offline");
      },
      reconcileJobs: async () => {
        calls.push("reconcile");
        return ["orphan-1"];
      },
      setupCronSchedulers: () => {
        calls.push("cron");
        return cronHandles as never;
      },
    });

    expect(calls).toEqual(["offline", "reconcile", "cron"]);
    expect(result).toEqual({ cronHandles, interruptedJobIds: ["orphan-1"] });
    expect(readiness.snapshot()).toEqual({ status: "starting", phase: "cron-schedulers" });
  });

  it("fails readiness at the exact mandatory phase and does not continue", async () => {
    const readiness = new DataManagerReadiness();
    const setupCronSchedulers = vi.fn();

    await expect(
      initializeRequiredSubsystems({
        readiness,
        initializeOfflineStorage: async () => {},
        reconcileJobs: async () => {
          throw new Error("database unavailable");
        },
        setupCronSchedulers,
      }),
    ).rejects.toThrow("database unavailable");

    expect(readiness.snapshot()).toEqual({ status: "failed", phase: "job-reconciliation" });
    expect(setupCronSchedulers).not.toHaveBeenCalled();
  });

  it("fails readiness when the cron scheduler cannot be constructed", async () => {
    const readiness = new DataManagerReadiness();

    await expect(
      initializeRequiredSubsystems({
        readiness,
        initializeOfflineStorage: async () => {},
        reconcileJobs: async () => [],
        setupCronSchedulers: () => {
          throw new Error("cron setup failed");
        },
      }),
    ).rejects.toThrow("cron setup failed");

    expect(readiness.snapshot()).toEqual({ status: "failed", phase: "cron-schedulers" });
  });
});
