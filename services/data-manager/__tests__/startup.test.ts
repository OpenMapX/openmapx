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
    const poiHandles = handles();

    const result = await initializeRequiredSubsystems({
      readiness,
      initializeOfflineStorage: async () => {
        calls.push("offline");
      },
      verifyRedis: async () => {
        calls.push("redis");
      },
      reconcileJobs: async () => {
        calls.push("reconcile");
        return ["orphan-1"];
      },
      discoverPoiSources: async () => {
        calls.push("discover");
      },
      setupCronSchedulers: () => {
        calls.push("cron");
        return cronHandles as never;
      },
      setupPoiScheduler: () => {
        calls.push("poi-cron");
        return poiHandles as never;
      },
    });

    expect(calls).toEqual(["offline", "redis", "reconcile", "discover", "cron", "poi-cron"]);
    expect(result).toEqual({ cronHandles, poiHandles, interruptedJobIds: ["orphan-1"] });
    expect(readiness.snapshot()).toEqual({ status: "starting", phase: "cron-schedulers" });
  });

  it("fails readiness at the exact mandatory phase and does not continue", async () => {
    const readiness = new DataManagerReadiness();
    const discover = vi.fn();
    const setupCronSchedulers = vi.fn();

    await expect(
      initializeRequiredSubsystems({
        readiness,
        initializeOfflineStorage: async () => {},
        verifyRedis: async () => {
          throw new Error("redis unavailable");
        },
        reconcileJobs: async () => [],
        discoverPoiSources: discover,
        setupCronSchedulers,
        setupPoiScheduler: () => handles() as never,
      }),
    ).rejects.toThrow("redis unavailable");

    expect(readiness.snapshot()).toEqual({ status: "failed", phase: "redis" });
    expect(discover).not.toHaveBeenCalled();
    expect(setupCronSchedulers).not.toHaveBeenCalled();
  });

  it("stops the general cron scheduler when POI scheduler construction fails", async () => {
    const readiness = new DataManagerReadiness();
    const cronHandles = handles();

    await expect(
      initializeRequiredSubsystems({
        readiness,
        initializeOfflineStorage: async () => {},
        verifyRedis: async () => {},
        reconcileJobs: async () => [],
        discoverPoiSources: async () => {},
        setupCronSchedulers: () => cronHandles as never,
        setupPoiScheduler: () => {
          throw new Error("POI scheduler failed");
        },
      }),
    ).rejects.toThrow("POI scheduler failed");

    expect(cronHandles.stop).toHaveBeenCalledOnce();
    expect(readiness.snapshot()).toEqual({ status: "failed", phase: "cron-schedulers" });
  });
});
