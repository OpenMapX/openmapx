import { findRepoRoot } from "@openmapx/core/server";
import { dockerComposeAction } from "../utils/docker-compose";
import { renderAndPersistCompose } from "./admin-ops";
import {
  reconcileCommunityRepositoryTransactions,
  type ServiceRuntimeRecovery,
} from "./community-repositories";
import { createDurableOpsKey } from "./ops-client";
import { openRuntimeRecoveryAuthority } from "./runtime-recovery-authority";
import { mergeRuntimeRecovery, type RuntimeRecoveryRecord } from "./runtime-recovery-journal";
import { initServiceRegistry } from "./service-registry";
import { reconcileDurableServiceRuntime } from "./service-runtime-recovery";
import { applyTrustedConfiguration } from "./trusted-config-operations";

let changeQueue: Promise<unknown> = Promise.resolve();

/**
 * Run extension changes and their recovery one at a time. Recovery decides
 * from pending repository transactions, so it must never observe another
 * change's transaction before that change commits or rolls back.
 */
export function withExtensionChangeLock<T>(work: () => Promise<T>): Promise<T> {
  const run = changeQueue.then(work, work);
  changeQueue = run.catch(() => undefined);
  return run;
}

/**
 * Finish what an interrupted extension change left behind: settle its pending
 * repository transactions in the operations agent, restore the service
 * selection it changed, and repair the service runtimes it touched. The caller
 * holds the extension change lock.
 */
export async function recoverInterruptedExtensionChanges(signal?: AbortSignal): Promise<void> {
  const runtimeRecoveryJournal = await openRuntimeRecoveryAuthority(findRepoRoot());
  const serviceRecovery: ServiceRuntimeRecovery = await reconcileCommunityRepositoryTransactions({
    signal,
    restoreSelection: async (roots, recoveryId) => {
      await initServiceRegistry();
      await applyTrustedConfiguration({
        kind: "serviceSelection.apply",
        selectedRoots: roots,
        operationKey: createDurableOpsKey("startup.selection.recovery", recoveryId),
        signal,
      });
    },
    persistRuntimeRecovery: async (recovery) => {
      if (!recovery.incidentId) {
        throw new Error("Service runtime recovery is missing its durable incident identity");
      }
      const discovered: RuntimeRecoveryRecord = {
        version: 1,
        incidentId: recovery.incidentId,
        orphanedServiceIds: [...recovery.orphanedServiceIds],
        restartServiceIds: [...recovery.restartServiceIds],
      };
      const retained = runtimeRecoveryJournal.record();
      await runtimeRecoveryJournal.replace(
        retained === null ? discovered : mergeRuntimeRecovery(retained, discovered),
      );
    },
  });
  const incident = serviceRecovery.incidentId ?? "recovery-without-incident";
  await reconcileDurableServiceRuntime(serviceRecovery, runtimeRecoveryJournal, {
    // Runtime recovery uses the same typed operations as every other lifecycle
    // path, so it never needs a Docker socket either.
    remove: (serviceId) =>
      dockerComposeAction(serviceId, "remove", {
        operationKey: createDurableOpsKey(
          "startup.runtime-recovery.remove",
          `${incident}:${serviceId}`,
        ),
      }),
    recreate: (serviceId) =>
      dockerComposeAction(serviceId, "recreate-isolated", {
        operationKey: createDurableOpsKey(
          "startup.runtime-recovery.recreate",
          `${incident}:${serviceId}`,
        ),
      }),
    initializeRegistry: initServiceRegistry,
    renderCompose: async () => {
      await renderAndPersistCompose({
        operationKey: createDurableOpsKey("startup.runtime-recovery.render", incident),
      });
    },
  });
}
