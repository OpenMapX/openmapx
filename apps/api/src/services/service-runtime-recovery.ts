import {
  mergeRuntimeRecovery,
  type RuntimeRecoveryJournal,
  type RuntimeRecoveryRecord,
} from "./runtime-recovery-journal";
import type { ServiceRuntimeRecovery } from "./service-repositories";

interface ComposeResult {
  exitCode: number;
  classification?:
    | "ok"
    | "not_found"
    | "nonzero"
    | "timeout"
    | "aborted"
    | "output_limit"
    | "spawn_error"
    | "containment_failure";
}

function isSuccessfulComposeResult(result: ComposeResult): boolean {
  return (
    result.exitCode === 0 && (result.classification === undefined || result.classification === "ok")
  );
}

export interface ServiceRuntimeRecoveryDependencies {
  remove(serviceId: string): Promise<ComposeResult>;
  recreate(serviceId: string): Promise<ComposeResult>;
  initializeRegistry(): Promise<void>;
  renderCompose(): Promise<void>;
  checkpoint?(remaining: ServiceRuntimeRecovery): Promise<void>;
}

/** Reconcile Docker state after repository/selection recovery, before API startup. */
export async function reconcileServiceRuntime(
  recovery: ServiceRuntimeRecovery,
  dependencies: ServiceRuntimeRecoveryDependencies,
): Promise<void> {
  if (!recovery.runtimeRecoveryNeeded) return;
  const remaining: ServiceRuntimeRecovery = {
    ...recovery,
    orphanedServiceIds: [...recovery.orphanedServiceIds],
    restartServiceIds: [...recovery.restartServiceIds],
  };

  // This runs before compose is regenerated, so the stale file can still name
  // containers introduced by the interrupted transaction. A crash before the
  // first render legitimately produces "no such service" and no container.
  for (const serviceId of recovery.orphanedServiceIds) {
    const removed = await dependencies.remove(serviceId);
    if (!isSuccessfulComposeResult(removed) && removed.classification !== "not_found") {
      throw new Error(
        `Failed to remove stale service runtime ${serviceId} (${removed.classification ?? "nonzero"}, exit ${removed.exitCode})`,
      );
    }
    remaining.orphanedServiceIds = remaining.orphanedServiceIds.filter((id) => id !== serviceId);
    await dependencies.checkpoint?.(remaining);
  }

  await dependencies.initializeRegistry();
  await dependencies.renderCompose();
  for (const serviceId of recovery.restartServiceIds) {
    const restarted = await dependencies.recreate(serviceId);
    if (!isSuccessfulComposeResult(restarted)) {
      throw new Error(
        `Failed to restore service runtime ${serviceId} (${restarted.classification ?? "nonzero"}, exit ${restarted.exitCode})`,
      );
    }
    remaining.restartServiceIds = remaining.restartServiceIds.filter((id) => id !== serviceId);
    await dependencies.checkpoint?.(remaining);
  }
}

function recoveryRecord(recovery: ServiceRuntimeRecovery): RuntimeRecoveryRecord {
  if (!recovery.incidentId) {
    throw new Error("Service runtime recovery is missing its durable incident identity");
  }
  return {
    version: 1,
    incidentId: recovery.incidentId,
    orphanedServiceIds: [...recovery.orphanedServiceIds],
    restartServiceIds: [...recovery.restartServiceIds],
  };
}

/**
 * Merge newly discovered source-journal work with a retained incident, durably
 * checkpoint each completed effect, and clear only after the full incident has
 * reached terminal success. A restart never invents a new incident identity.
 */
export async function reconcileDurableServiceRuntime(
  discovered: ServiceRuntimeRecovery,
  journal: RuntimeRecoveryJournal,
  dependencies: ServiceRuntimeRecoveryDependencies,
): Promise<void> {
  let retained = journal.record();
  if (discovered.runtimeRecoveryNeeded) {
    const next = recoveryRecord(discovered);
    retained = retained === null ? next : mergeRuntimeRecovery(retained, next);
    await journal.replace(retained);
  }
  if (retained === null) return;

  await reconcileServiceRuntime(
    { ...retained, runtimeRecoveryNeeded: true },
    {
      ...dependencies,
      checkpoint: async (remaining) => {
        await journal.replace(recoveryRecord(remaining));
      },
    },
  );
  await journal.clear();
}
