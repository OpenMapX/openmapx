import {
  type ControlInstallation,
  startControlRetentionMaintenance,
} from "@openmapx/core/build-artifacts";
import type { CronHandles } from "./cron.js";
import type { DataManagerReadiness } from "./readiness.js";

export interface RequiredStartupDependencies {
  readiness: DataManagerReadiness;
  initializeOfflineStorage: () => Promise<void>;
  reconcileJobs: () => Promise<string[]>;
  setupCronSchedulers: () => CronHandles;
  controlInstallation?: ControlInstallation;
  onRetentionError?: (error: unknown) => void;
}

export interface RequiredStartupResult {
  cronHandles: CronHandles;
  interruptedJobIds: string[];
  stopControlRetention?: () => Promise<void>;
}

/** Initialize every subsystem required by the advertised data-manager routes. */
export async function initializeRequiredSubsystems(
  dependencies: RequiredStartupDependencies,
): Promise<RequiredStartupResult> {
  let stopControlRetention: (() => Promise<void>) | undefined;
  try {
    dependencies.readiness.setPhase("offline-storage");
    await dependencies.initializeOfflineStorage();

    dependencies.readiness.setPhase("job-reconciliation");
    const interruptedJobIds = await dependencies.reconcileJobs();

    if (dependencies.controlInstallation)
      stopControlRetention = await startControlRetentionMaintenance(
        dependencies.controlInstallation,
        dependencies.onRetentionError ??
          (() => console.warn("Control retention cleanup requires attention")),
      );

    dependencies.readiness.setPhase("cron-schedulers");
    const cronHandles = dependencies.setupCronSchedulers();

    return {
      cronHandles,
      interruptedJobIds,
      ...(stopControlRetention ? { stopControlRetention } : {}),
    };
  } catch (error) {
    await stopControlRetention?.();
    dependencies.readiness.markFailed();
    throw error;
  }
}
