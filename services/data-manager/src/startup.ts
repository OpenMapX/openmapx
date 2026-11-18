import { type ControlInstallation, startControlPrune } from "@openmapx/core/build-artifacts";
import type { CronHandles } from "./cron.js";
import type { DataManagerReadiness } from "./readiness.js";

export interface RequiredStartupDependencies {
  readiness: DataManagerReadiness;
  initializeOfflineStorage: () => Promise<void>;
  /** Reconciles the data executions a previous process left unsettled. */
  reconcileJobs: () => Promise<void>;
  setupCronSchedulers: () => CronHandles;
  controlInstallation?: ControlInstallation;
  onControlPruneError?: (error: unknown) => void;
  onControlPruneStarted?: (stop: () => Promise<void>) => void;
  /** Removes this service's own rows for executions whose records are pruned. */
  removePrunedRows?: (operationKeys: readonly string[]) => Promise<void>;
}

export interface RequiredStartupResult {
  cronHandles: CronHandles;
  stopControlPrune?: () => Promise<void>;
}

/** Initialize every subsystem required by the advertised data-manager routes. */
export async function initializeRequiredSubsystems(
  dependencies: RequiredStartupDependencies,
): Promise<RequiredStartupResult> {
  let stopControlPrune: (() => Promise<void>) | undefined;
  try {
    dependencies.readiness.setPhase("offline-storage");
    await dependencies.initializeOfflineStorage();

    dependencies.readiness.setPhase("job-reconciliation");
    await dependencies.reconcileJobs();

    if (dependencies.controlInstallation) {
      const prune = startControlPrune(dependencies.controlInstallation, {
        onError:
          dependencies.onControlPruneError ??
          ((error) => console.warn("Control record prune failed", error)),
        beforeRemove: dependencies.removePrunedRows,
      });
      let stopRequested = false;
      stopControlPrune = async () => {
        stopRequested = true;
        await prune.stop();
      };
      dependencies.onControlPruneStarted?.(stopControlPrune);
      await prune.ready;
      // Shutdown during the initial prune ends startup before any scheduler.
      if (stopRequested) throw new DOMException("Data manager startup stopped", "AbortError");
    }

    dependencies.readiness.setPhase("cron-schedulers");
    const cronHandles = dependencies.setupCronSchedulers();

    return {
      cronHandles,
      ...(stopControlPrune ? { stopControlPrune } : {}),
    };
  } catch (error) {
    await stopControlPrune?.();
    dependencies.readiness.markFailed();
    throw error;
  }
}
