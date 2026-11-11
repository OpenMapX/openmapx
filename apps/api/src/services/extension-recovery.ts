import { randomUUID } from "node:crypto";
import { findRepoRoot } from "@openmapx/core/server";
import { isIntegrationHostInitialized, reloadIntegrations } from "../integration-host";
import { dockerComposeAction } from "../utils/docker-compose";
import { renderAndPersistCompose } from "./admin-ops";
import { recoverAgentIntegrations } from "./agent-integrations";
import {
  reconcileCommunityRepositoryTransactions,
  type ServiceRuntimeRecovery,
} from "./community-repositories";
import type { JobContext } from "./job-runner";
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
 * integration and repository transactions in the operations agent, restore the
 * service selection the change touched, and repair the service runtimes it
 * touched. Settling an integration needs the job that is running it to own
 * its operations, so startup recovery, which runs without one, only observes
 * them. The caller holds the extension change lock.
 */
export async function recoverInterruptedExtensionChanges(
  signal?: AbortSignal,
  options: { ctx?: JobContext } = {},
): Promise<void> {
  const integrations = await recoverAgentIntegrations({
    signal,
    ctx: options.ctx,
  });
  if (
    integrations.rolledBack.length > 0 &&
    // At startup the host loads what the agent now reports by itself.
    isIntegrationHostInitialized()
  ) {
    await reloadIntegrations().catch((error) => {
      console.warn(
        `[extension-recovery] Integrations could not be reloaded after recovery: ${(error as Error).message}`,
      );
    });
  }
  const runtimeRecoveryJournal = await openRuntimeRecoveryAuthority(findRepoRoot());
  const serviceRecovery: ServiceRuntimeRecovery = await reconcileCommunityRepositoryTransactions({
    ctx: options.ctx,
    signal,
    restoreSelection: async (roots, recoveryId) => {
      await initServiceRegistry({ strict: true });
      await applyTrustedConfiguration({
        kind: "serviceSelection.apply",
        selectedRoots: roots,
        // A retry after a crash may follow a successful apply, so each attempt
        // needs its own key; applying the same selection again is harmless.
        operationKey: createDurableOpsKey(
          "startup.selection.recovery",
          `${recoveryId}:${randomUUID()}`,
        ),
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
    initializeRegistry: () => initServiceRegistry({ strict: true }),
    renderCompose: async () => {
      await renderAndPersistCompose({
        operationKey: createDurableOpsKey("startup.runtime-recovery.render", incident),
      });
    },
  });
}
