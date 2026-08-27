import type { CronHandles } from "./cron.js";
import type { PoiSchedulerHandles } from "./jobs/poi-ingest/scheduler.js";
import type { DataManagerReadiness } from "./readiness.js";

export interface RequiredStartupDependencies {
  readiness: DataManagerReadiness;
  initializeOfflineStorage: () => Promise<void>;
  verifyRedis: () => Promise<void>;
  reconcileJobs: () => Promise<string[]>;
  discoverPoiSources: () => Promise<void>;
  setupCronSchedulers: () => CronHandles;
  setupPoiScheduler: () => PoiSchedulerHandles;
}

export interface RequiredStartupResult {
  cronHandles: CronHandles;
  poiHandles: PoiSchedulerHandles;
  interruptedJobIds: string[];
}

/** Initialize every subsystem required by the advertised data-manager routes. */
export async function initializeRequiredSubsystems(
  dependencies: RequiredStartupDependencies,
): Promise<RequiredStartupResult> {
  let cronHandles: CronHandles | undefined;
  try {
    dependencies.readiness.setPhase("offline-storage");
    await dependencies.initializeOfflineStorage();

    dependencies.readiness.setPhase("redis");
    await dependencies.verifyRedis();

    dependencies.readiness.setPhase("job-reconciliation");
    const interruptedJobIds = await dependencies.reconcileJobs();

    dependencies.readiness.setPhase("poi-source-discovery");
    await dependencies.discoverPoiSources();

    dependencies.readiness.setPhase("cron-schedulers");
    cronHandles = dependencies.setupCronSchedulers();
    const poiHandles = dependencies.setupPoiScheduler();

    return { cronHandles, poiHandles, interruptedJobIds };
  } catch (error) {
    cronHandles?.stop();
    dependencies.readiness.markFailed();
    throw error;
  }
}
