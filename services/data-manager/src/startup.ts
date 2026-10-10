import type { CronHandles } from "./cron.js";
import type { DataManagerReadiness } from "./readiness.js";

export interface RequiredStartupDependencies {
  readiness: DataManagerReadiness;
  initializeOfflineStorage: () => Promise<void>;
  reconcileJobs: () => Promise<string[]>;
  setupCronSchedulers: () => CronHandles;
}

export interface RequiredStartupResult {
  cronHandles: CronHandles;
  interruptedJobIds: string[];
}

/** Initialize every subsystem required by the advertised data-manager routes. */
export async function initializeRequiredSubsystems(
  dependencies: RequiredStartupDependencies,
): Promise<RequiredStartupResult> {
  try {
    dependencies.readiness.setPhase("offline-storage");
    await dependencies.initializeOfflineStorage();

    dependencies.readiness.setPhase("job-reconciliation");
    const interruptedJobIds = await dependencies.reconcileJobs();

    dependencies.readiness.setPhase("cron-schedulers");
    const cronHandles = dependencies.setupCronSchedulers();

    return { cronHandles, interruptedJobIds };
  } catch (error) {
    dependencies.readiness.markFailed();
    throw error;
  }
}
