import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlDirectories,
} from "@openmapx/core/build-artifacts";
import { describe, expect, it, vi } from "vitest";
import { DataManagerReadiness } from "../src/readiness.js";
import { initializeRequiredSubsystems } from "../src/startup.js";

function handles() {
  return { stop: vi.fn() };
}

describe("initializeRequiredSubsystems", () => {
  it("publishes the stop handle before awaiting the initial prune and does not start cron after shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "omx-startup-stop-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await provisionControlDirectories(root);
    const installation = openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["data-manager"],
    });
    const setupCronSchedulers = vi.fn();
    let stopped: Promise<void> | undefined;
    try {
      await expect(
        initializeRequiredSubsystems({
          readiness: new DataManagerReadiness(),
          controlInstallation: installation,
          initializeOfflineStorage: async () => {},
          reconcileJobs: async () => {},
          setupCronSchedulers,
          onControlPruneStarted: (stop) => {
            stopped = stop();
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await stopped;
      expect(setupCronSchedulers).not.toHaveBeenCalled();
    } finally {
      await stopped;
      closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      },
      setupCronSchedulers: () => {
        calls.push("cron");
        return cronHandles as never;
      },
    });

    expect(calls).toEqual(["offline", "reconcile", "cron"]);
    expect(result).toEqual({ cronHandles });
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
        reconcileJobs: async () => {},
        setupCronSchedulers: () => {
          throw new Error("cron setup failed");
        },
      }),
    ).rejects.toThrow("cron setup failed");

    expect(readiness.snapshot()).toEqual({ status: "failed", phase: "cron-schedulers" });
  });
});
