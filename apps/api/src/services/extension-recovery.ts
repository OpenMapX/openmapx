import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { findRepoRoot } from "@openmapx/core/server";
import { isIntegrationHostInitialized, reloadIntegrations } from "../integration-host";
import { dockerComposeAction } from "../utils/docker-compose";
import { renderAndPersistCompose } from "./admin-ops";
import { recoverAgentIntegrations } from "./agent-integrations";
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
 * integration and repository transactions in the operations agent, have the
 * agent adopt integrations earlier releases installed, restore the service
 * selection the change touched, and repair the service runtimes it touched.
 * The caller holds the extension change lock.
 */
/**
 * Adopt the integrations earlier releases installed, which the agent holds no
 * record of, then reload the integration host if any was recorded. Startup
 * runs this in the background once the API listens: each adoption downloads
 * the extension's archive again. The caller holds the extension change lock.
 */
export async function adoptUnrecordedIntegrations(signal?: AbortSignal): Promise<void> {
  const integrations = await recoverAgentIntegrations({ signal });
  if (integrations.adopted.length > 0 && isIntegrationHostInitialized()) {
    await reloadIntegrations();
  }
}

export async function recoverInterruptedExtensionChanges(
  signal?: AbortSignal,
  options: { adoptIntegrations?: boolean } = {},
): Promise<void> {
  const integrations = await recoverAgentIntegrations({
    signal,
    adopt: options.adoptIntegrations ?? true,
  });
  if (
    (integrations.rolledBack.length > 0 || integrations.adopted.length > 0) &&
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

const LEGACY_INSTALL_JOURNAL = /^\.extension-install-journal-[a-f0-9]{24}\.json$/;

/**
 * Earlier releases journaled integration installs in `custom_integrations`
 * themselves. The operations agent now owns that directory, and recovery has
 * it verify every integration such a change left behind by adoption, so a
 * leftover journal is only reported. Never throws.
 */
export function warnAboutLegacyInstallJournals(
  customIntegrationsDir: string,
  warn: (message: string) => void,
): void {
  let journals: string[];
  try {
    journals = readdirSync(customIntegrationsDir).filter((name) =>
      LEGACY_INSTALL_JOURNAL.test(name),
    );
  } catch {
    return;
  }
  if (journals.length === 0) return;
  warn(
    `Found ${journals.length} extension install journal(s) from an earlier release in ${customIntegrationsDir} (${journals.join(", ")}). ` +
      "The operations agent verifies the integrations of that interrupted change by adoption; integrations it cannot verify need a reinstall. The journal files can be deleted.",
  );
}
