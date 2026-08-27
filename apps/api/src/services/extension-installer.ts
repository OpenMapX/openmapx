import { services as coreServices, findRepoRoot } from "@openmapx/core/server";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/integration-framework";
import {
  backupInstalledIntegration,
  installIntegration as coreInstallIntegration,
  removeIntegration as coreRemoveIntegration,
  discardInstalledIntegrationBackup,
  type IntegrationRollbackBackup,
  restoreInstalledIntegration,
} from "@openmapx/integration-framework/installer";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import type { ServiceRepositoryRow } from "../db/schema";
import {
  installedExtension,
  installedExtensionComponent,
  installedIntegration,
  serviceRepository,
} from "../db/schema";
import { reloadIntegrations } from "../integration-host";
import { dbActorId } from "../utils/actor";
import { dockerComposeAction } from "../utils/docker-compose";
import { getServiceSelectionSummary } from "./admin-cli";
import { renderAndPersistCompose, serviceStart } from "./admin-ops";
import { assertComponentOwnership } from "./extension-component-ownership";
import {
  appendIntegrationJournalEntry,
  createExtensionInstallJournal,
  type ExtensionInstallJournal,
  markExtensionInstallJournalRestoring,
  markIntegrationJournalEntryInstalled,
  reconcileExtensionInstallJournal,
} from "./extension-install-journal";
import { getKillSwitch } from "./extension-store";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";
import { getServiceRegistry, initServiceRegistry } from "./service-registry";
import {
  backupRepo,
  discardRepoBackup,
  discardRepoPreparation,
  discardStagedRepo,
  hashUrl,
  type PreparedServiceRepository,
  publishStagedRepo,
  removeRepo,
  restoreRepo,
  type ServiceRepoRollbackBackup,
  type StagedServiceRepository,
  stageRepo,
} from "./service-repositories";
import { applyTrustedConfiguration } from "./trusted-config-operations";

type ExtensionManifest = coreServices.ExtensionManifest;
const ROOT_DIR = findRepoRoot();

export type ExtensionTrust = "built-in" | "verified" | "community";

export interface InstallExtensionOptions {
  manifest: ExtensionManifest;
  /** Catalog/source URL the bundle came from (null for raw install-by-manifest). */
  sourceUrl?: string;
  sourceTrust: ExtensionTrust;
  actorId?: string;
}

/**
 * The validated, immutable result of preflight. `applyExtensionInstall` accepts
 * only this, so every identity, ownership, and revocation decision is made
 * before the first filesystem, registry, database, or container mutation.
 */
export interface ExtensionInstallPreflight {
  readonly manifest: ExtensionManifest;
  readonly components: readonly coreServices.ExtensionComponentRef[];
  readonly serviceRepos: ReadonlyMap<
    string,
    ExtensionManifest["services"] extends Array<infer S> | undefined ? S : never
  >;
}

export class ExtensionPreflightError extends Error {
  override readonly name = "ExtensionPreflightError";
}

/**
 * Revocation is authoritative at execution time, not at queue time. A denial
 * published while the job waited must still stop the install.
 */
async function assertNotRevoked(extensionId: string, version: string): Promise<void> {
  const kill = await getKillSwitch();
  const removed = kill.removed.get(extensionId);
  if (removed !== undefined) {
    throw new ExtensionPreflightError(`Extension "${extensionId}" is delisted: ${removed}`);
  }
  const critical = kill.critical.get(extensionId);
  if (critical && (critical.maxVersion === undefined || version <= critical.maxVersion)) {
    throw new ExtensionPreflightError(
      `Extension "${extensionId}" is flagged critical: ${critical.reason}`,
    );
  }
}

/**
 * Validate identity, uniqueness, ownership, and platform compatibility. Performs
 * no mutation, so any failure leaves the deployment exactly as it was.
 */
export async function preflightExtensionInstall(
  opts: InstallExtensionOptions,
): Promise<ExtensionInstallPreflight> {
  const { manifest } = opts;
  if (manifest.platform && !satisfiesPlatformVersion(manifest.platform)) {
    throw new ExtensionPreflightError(
      `Extension "${manifest.id}" requires platform >= ${manifest.platform} (this is ${PLATFORM_VERSION}).`,
    );
  }

  const components = coreServices.extensionComponentSummary(manifest);
  const seen = new Set<string>();
  for (const component of components) {
    const key = `${component.kind}:${component.id}`;
    if (seen.has(key)) {
      throw new ExtensionPreflightError(
        `Extension "${manifest.id}" declares component ${key} more than once`,
      );
    }
    seen.add(key);
  }

  const serviceRepos = new Map<string, NonNullable<ExtensionManifest["services"]>[number]>();
  for (const component of manifest.services ?? []) {
    const existing = serviceRepos.get(component.repo);
    if (existing && existing.ref !== component.ref) {
      throw new ExtensionPreflightError(
        `Extension service repository "${component.repo}" is requested at conflicting refs`,
      );
    }
    serviceRepos.set(component.repo, component);
  }

  await assertComponentOwnership(manifest.id, components);

  return { manifest, components, serviceRepos: serviceRepos as never };
}

async function serviceRepoSnapshot(url: string): Promise<ServiceRepositoryRow | undefined> {
  const [row] = await db
    .select()
    .from(serviceRepository)
    .where(eq(serviceRepository.hash, hashUrl(url)))
    .limit(1);
  return row;
}

async function integrationInstalledExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: installedIntegration.id })
    .from(installedIntegration)
    .where(eq(installedIntegration.id, id))
    .limit(1);
  return !!row;
}

// Enable/disable services for the *running* api without an api restart. The
// app-api container always carries a baked OPENMAPX_ENABLED_SERVICES (the
// renderer injects it — see buildAppApiServiceEnv), which puts selection in
// "env mode" where the file can't be edited via the normal guarded path. So we
// (a) apply the new enabled set to the in-memory registry — that's what
// renderAndPersistCompose reads to (re)bake the env + emit the compose this
// instant — and (b) write the selection file too, the source of truth a later
// host-side `compose render` consumes. Both must agree; do not re-init the
// registry from env after this (that would re-read the stale baked list).

/** Re-derive and apply an enabled set from a fresh root list, persist the file. */
async function applySelectionRoots(
  roots: string[],
  allowMissing: boolean,
  operationKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const registry = getServiceRegistry();
  const normalized = coreServices.normalizeServiceIds(roots);
  const expanded = coreServices.expandServiceSelection(registry.list(), normalized, {
    allowMissingSelected: allowMissing,
  });
  if (expanded.missingIds.length > 0) {
    throw new Error(`Selected service(s) are not installed: ${expanded.missingIds.join(", ")}`);
  }
  await applyTrustedConfiguration({
    kind: "serviceSelection.apply",
    selectedRoots: normalized,
    operationKey,
    signal,
  });
  registry.applyEnabledIds(expanded.enabledIds);
}

/** Add service ids to the selection. Returns the ids newly added. */
async function enableServicesInSelection(
  serviceIds: string[],
  operationKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const registry = getServiceRegistry();
  const roots = [...getServiceSelectionSummary(registry).selectedRoots];
  const added = serviceIds.filter((id) => !roots.includes(id));
  if (added.length === 0) return [];
  await applySelectionRoots([...roots, ...added], false, operationKey, signal);
  return added;
}

async function disableServicesInSelection(
  serviceIds: string[],
  operationKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const registry = getServiceRegistry();
  const roots = getServiceSelectionSummary(registry).selectedRoots.filter(
    (r) => !serviceIds.includes(r),
  );
  await applySelectionRoots(roots, true, operationKey, signal);
}

interface InstallLedger {
  addedRepoHashes: string[]; // repos newly cloned this run (eligible for rollback removal)
  enabledServiceIds: string[]; // services newly enabled this run
  installedIntegrationIds: string[]; // integrations newly installed this run
  previousIntegrations: IntegrationRollbackBackup[];
  previousServiceRepos: ServiceRepoRollbackBackup[];
  newRepoPreparationJournals: string[];
  touchedServiceIds: string[];
  previouslyEnabledServiceIds: string[];
  selectedRootsBefore: string[] | null;
}

/**
 * Orchestrated, atomic-ish install of an extension bundle. Reuses the existing
 * per-component pipelines (service repo clone + compose render/start; integration
 * artifact install + hot reload) and records one `installed_extension` parent so
 * the bundle removes/updates as a unit. On any failure the steps completed this
 * run are rolled back best-effort; parts that pre-existed are left untouched.
 */
export async function installExtension(
  ctx: JobContext,
  opts: InstallExtensionOptions,
): Promise<{ id: string; components: number }> {
  const { manifest } = opts;
  // Synthetic (loopback) actors have no user row → attribute to null.
  const installedBy = dbActorId(opts.actorId);

  // Everything that can be decided without touching the deployment is decided
  // here, before the first mutation.
  await preflightExtensionInstall(opts);
  // Revocation can land between queueing and execution, so it is rechecked
  // immediately before the first mutation as well as at the end.
  await assertNotRevoked(manifest.id, manifest.version);

  const ledger: InstallLedger = {
    addedRepoHashes: [],
    enabledServiceIds: [],
    installedIntegrationIds: [],
    previousIntegrations: [],
    previousServiceRepos: [],
    newRepoPreparationJournals: [],
    touchedServiceIds: [],
    previouslyEnabledServiceIds: [],
    selectedRootsBefore: null,
  };
  let bookkeepingCommitted = false;
  let rollbackRequired = false;
  let integrationJournal: ExtensionInstallJournal | null = null;
  const stagedServiceRepos = new Map<string, StagedServiceRepository>();

  try {
    const serviceComponents = manifest.services ?? [];
    const integrationComponents = manifest.integrations ?? [];
    const pendingServiceRepoRows: PreparedServiceRepository[] = [];
    // Repository URL -> the row this install actually published for it, so a
    // component's provenance is checked against the record we created rather
    // than against a re-derived identifier.
    const publishedByRepo = new Map<string, PreparedServiceRepository>();
    // Validated by preflight: one ref per repository.
    const serviceRepos = new Map<string, (typeof serviceComponents)[number]>();
    for (const component of serviceComponents) serviceRepos.set(component.repo, component);

    // Snapshot and stage every repository before copying any installed checkout
    // aside. A stage is the exact cloned, fully validated snapshot that is later
    // published, so a mutable ref cannot change between preflight and update.
    const existingServiceRepos = new Map<string, ServiceRepositoryRow | undefined>();
    for (const svc of serviceRepos.values()) {
      existingServiceRepos.set(svc.repo, await serviceRepoSnapshot(svc.repo));
    }

    if (serviceComponents.length > 0) {
      const registry = getServiceRegistry();
      ledger.selectedRootsBefore = [...getServiceSelectionSummary(registry).selectedRoots];
      ledger.touchedServiceIds = serviceComponents.map((component) => component.service);
      ledger.previouslyEnabledServiceIds = ledger.touchedServiceIds.filter(
        (serviceId) => registry.get(serviceId)?.enabled === true,
      );
    }

    for (const svc of serviceRepos.values()) {
      const previous = existingServiceRepos.get(svc.repo);
      stagedServiceRepos.set(
        svc.repo,
        await stageRepo(svc.repo, {
          ref: svc.ref,
          managedByExtension: manifest.id,
          journalNewInstall: !previous,
          selectionBefore: ledger.selectedRootsBefore ?? undefined,
          minimumLastFetchedAtExclusive: previous?.lastFetchedAt ?? undefined,
          touchedServiceIds: ledger.touchedServiceIds,
          previouslyEnabledServiceIds: ledger.previouslyEnabledServiceIds,
        }),
      );
    }

    // 1. Register + pin every service repo.
    for (const svc of serviceRepos.values()) {
      const previous = existingServiceRepos.get(svc.repo);
      if (previous) {
        ledger.previousServiceRepos.push(
          backupRepo(previous, {
            selectionBefore: ledger.selectedRootsBefore ?? undefined,
            touchedServiceIds: ledger.touchedServiceIds,
            previouslyEnabledServiceIds: ledger.previouslyEnabledServiceIds,
          }),
        );
        rollbackRequired = true;
      }
      await ctx.log(`Registering service repo ${svc.repo}${svc.ref ? `@${svc.ref}` : ""}...`);
      const stage = stagedServiceRepos.get(svc.repo);
      if (!stage) throw new Error(`Service repository "${svc.repo}" was not staged`);
      const row = await publishStagedRepo(stage);
      stagedServiceRepos.delete(svc.repo);
      const { preparationJournal, ...repositoryRow } = row;
      rollbackRequired = true;
      pendingServiceRepoRows.push(repositoryRow);
      publishedByRepo.set(svc.repo, repositoryRow);
      if (preparationJournal) ledger.newRepoPreparationJournals.push(preparationJournal);
      if (!previous) ledger.addedRepoHashes.push(row.hash);
    }
    await ctx.setProgress(25);

    // 2. Reload the registry so the freshly-cloned services appear in list(),
    // then enable them in-memory (applySelectionRoots also persists the file).
    // Do NOT re-init after enabling — that re-reads the stale baked env list.
    if (serviceComponents.length > 0) {
      await initServiceRegistry();
      const registry = getServiceRegistry();
      for (const component of serviceComponents) {
        const service = registry.get(component.service);
        if (!service || service.isBuiltIn) {
          throw new Error(
            `Extension service "${component.service}" was not loaded from its registered repository`,
          );
        }
        if (!service.manifest.container.digest) {
          throw new Error(
            `Extension service "${component.service}" must pin its container image by digest`,
          );
        }
        // The registry record must prove it came from this extension's own
        // repository and is owned by this extension before it can be linked.
        const provenance = publishedByRepo.get(component.repo);
        if (!provenance) {
          throw new Error(
            `Extension service "${component.service}" has no registered repository provenance`,
          );
        }
        if (provenance.managedByExtension !== manifest.id) {
          throw new Error(
            `Extension service "${component.service}" is not owned by extension "${manifest.id}"`,
          );
        }
      }
      const newlyEnabled = await enableServicesInSelection(
        serviceComponents.map((s) => s.service),
        createDurableOpsKey("extension.selection.enable", `${ctx.jobId}:${manifest.id}`),
        ctx.signal,
      );
      ledger.enabledServiceIds.push(...newlyEnabled);

      await ctx.log("Rendering compose...");
      await renderAndPersistCompose({
        operationKey: createDurableOpsKey("extension.config.render", `${ctx.jobId}:${manifest.id}`),
        signal: ctx.signal,
      });
      for (const svc of serviceComponents) {
        // The rendered reference includes the mandatory digest. Pull failure is
        // fatal: starting a cached image would make the recorded extension
        // version claim an artifact that was never acquired.
        const pulled = await dockerComposeAction(svc.service, "pull", {
          operationKey: createDurableOpsKey(
            "extension.service.pull",
            `${ctx.jobId}:${manifest.id}:${svc.service}`,
          ),
          signal: ctx.signal,
        });
        if (pulled.exitCode !== 0) {
          throw new Error(`Failed to pull community service image ${svc.service}`);
        }
        await serviceStart(svc.service, ctx);
      }
    }
    await ctx.setProgress(60);

    // 3. Install each integration artifact, then hot-reload once. The
    // bookkeeping rows are collected here and written in the step-4 transaction
    // so nothing is persisted until the whole record set can land atomically.
    const pendingIntegrationRows: Array<{ id: string; repository: string }> = [];
    if (integrationComponents.length > 0) {
      integrationJournal = createExtensionInstallJournal(
        ROOT_DIR,
        manifest.id,
        manifest as unknown as Record<string, unknown>,
      );
      rollbackRequired = true;
    }
    for (const intg of integrationComponents) {
      if (!integrationJournal) throw new Error("Integration install journal was not initialized");
      const existed = await integrationInstalledExists(intg.id);
      if (existed) {
        const backup = backupInstalledIntegration(ROOT_DIR, intg.id);
        if (!backup) {
          throw new Error(`Installed integration "${intg.id}" is missing from disk`);
        }
        ledger.previousIntegrations.push(backup);
      }
      appendIntegrationJournalEntry(integrationJournal, {
        id: intg.id,
        backupDirectory:
          ledger.previousIntegrations.find((backup) => backup.id === intg.id)?.backupDirectory ??
          null,
      });
      await ctx.log(`Installing integration ${intg.id} from ${intg.artifact}...`);
      const installed = await coreInstallIntegration({
        rootDir: ROOT_DIR,
        source: intg.artifact,
        sourceKind: "artifact",
        artifactSha256: intg.sha256,
        allowLocalSources: false,
        signal: ctx.signal,
        onLog: (line, stream) => {
          ctx.log(line, stream).catch(() => {});
        },
      });
      // The artifact declares its own id. If it does not match the component
      // the manifest authorized, the extension would own — and later remove —
      // an integration nobody approved.
      if (installed.id !== intg.id) {
        throw new Error(
          `Integration artifact installed "${installed.id}" but the manifest declared "${intg.id}"`,
        );
      }
      markIntegrationJournalEntryInstalled(integrationJournal, intg.id);
      if (!existed) ledger.installedIntegrationIds.push(intg.id);

      pendingIntegrationRows.push({
        id: intg.id,
        repository: opts.sourceUrl ?? intg.artifact,
      });
    }
    if (integrationComponents.length > 0) {
      await ctx.log("Reloading integrations...");
      const r = await reloadIntegrations();
      await ctx.log(`Reload complete: ${r.reloaded} reloaded, ${r.enabled} enabled`);
    }
    await ctx.setProgress(90);

    // 4. Record all bookkeeping in one transaction: the deferred per-integration
    // rows, the parent record, and the component links. A crash at any point
    // then leaves either the whole consistent record set (update case) or none
    // of this run's rows (fresh install), never a parent with zero components —
    // which removeExtension reads to decide what to tear down.
    const now = new Date();
    const components = coreServices.extensionComponentSummary(manifest);
    // Last gate before the install becomes authoritative.
    await assertNotRevoked(manifest.id, manifest.version);
    await assertComponentOwnership(manifest.id, components);
    await db.transaction(async (tx) => {
      for (const row of pendingServiceRepoRows) {
        await tx
          .insert(serviceRepository)
          .values(row)
          .onConflictDoUpdate({
            target: serviceRepository.hash,
            set: {
              displayName: row.displayName,
              lastFetchedAt: row.lastFetchedAt,
              lastSha: row.lastSha,
              pinnedRef: row.pinnedRef,
              managedByExtension: row.managedByExtension,
            },
          });
      }
      for (const row of pendingIntegrationRows) {
        await tx
          .insert(installedIntegration)
          .values({
            id: row.id,
            repository: row.repository,
            installedVersion: manifest.version,
            sourceType: "registry",
            installedAt: now,
            updatedAt: now,
            installedBy,
            managedByExtension: manifest.id,
          })
          .onConflictDoUpdate({
            target: installedIntegration.id,
            set: {
              repository: row.repository,
              installedVersion: manifest.version,
              sourceType: "registry",
              updatedAt: now,
              managedByExtension: manifest.id,
            },
          });
      }

      await tx
        .insert(installedExtension)
        .values({
          id: manifest.id,
          name: manifest.name,
          sourceUrl: opts.sourceUrl ?? null,
          sourceTrust: opts.sourceTrust,
          installedVersion: manifest.version,
          manifest: manifest as unknown as Record<string, unknown>,
          installedAt: now,
          updatedAt: now,
          installedBy,
        })
        .onConflictDoUpdate({
          target: installedExtension.id,
          set: {
            name: manifest.name,
            sourceUrl: opts.sourceUrl ?? null,
            sourceTrust: opts.sourceTrust,
            installedVersion: manifest.version,
            manifest: manifest as unknown as Record<string, unknown>,
            updatedAt: now,
          },
        });

      await tx
        .delete(installedExtensionComponent)
        .where(eq(installedExtensionComponent.extensionId, manifest.id));
      if (components.length > 0) {
        await tx.insert(installedExtensionComponent).values(
          components.map((c) => ({
            extensionId: manifest.id,
            kind: c.kind,
            componentId: c.id,
          })),
        );
      }
    });
    bookkeepingCommitted = true;

    // Once the bookkeeping transaction commits, the install is authoritative.
    // Job-reporting failures must not roll back external state while leaving
    // committed extension rows behind.
    await ctx.setProgress(100).catch(() => {});
    for (const backup of ledger.previousServiceRepos) {
      try {
        discardRepoBackup(backup);
      } catch (error) {
        await ctx
          .log(
            `Cleanup: failed to remove service repository backup for ${backup.snapshot.url}: ${(error as Error).message}`,
            "stderr",
          )
          .catch(() => {});
      }
    }
    for (const journal of ledger.newRepoPreparationJournals) {
      try {
        discardRepoPreparation(journal);
      } catch (error) {
        await ctx
          .log(
            `Cleanup: failed to remove repository preparation journal: ${(error as Error).message}`,
            "stderr",
          )
          .catch(() => {});
      }
    }
    for (const backup of ledger.previousIntegrations) {
      try {
        discardInstalledIntegrationBackup(ROOT_DIR, backup);
      } catch (error) {
        await ctx
          .log(
            `Cleanup: failed to remove integration backup for ${backup.id}: ${(error as Error).message}`,
            "stderr",
          )
          .catch(() => {});
      }
    }
    if (integrationJournal) {
      await reconcileExtensionInstallJournal(ROOT_DIR, integrationJournal.path, async () => true);
    }
    await ctx
      .log(`Extension "${manifest.id}" installed (${components.length} component(s)).`)
      .catch(() => {});
    return { id: manifest.id, components: components.length };
  } catch (err) {
    for (const stage of stagedServiceRepos.values()) {
      try {
        discardStagedRepo(stage);
      } catch {
        // Stages already consumed by publication are no longer owned here.
      }
    }
    if (bookkeepingCommitted) throw err;
    if (!rollbackRequired) throw err;
    await ctx
      .log(`Install failed: ${(err as Error).message}. Rolling back...`, "stderr")
      .catch(() => {});
    if (integrationJournal) {
      try {
        markExtensionInstallJournalRestoring(integrationJournal);
      } catch (journalError) {
        await ctx
          .log(
            `Rollback deferred to startup because the integration recovery journal could not be checkpointed: ${(journalError as Error).message}`,
            "stderr",
          )
          .catch(() => {});
        // Do not mutate integration artifacts without first recording the
        // restoring phase. The existing journal and backups let startup retry
        // from the last durable state.
        throw err;
      }
    }
    await rollbackInstall(ctx, ledger).catch((rbErr) => {
      ctx
        .log(`Rollback encountered an error: ${(rbErr as Error).message}`, "stderr")
        .catch(() => {});
    });
    if (integrationJournal) {
      await reconcileExtensionInstallJournal(
        ROOT_DIR,
        integrationJournal.path,
        async () => false,
      ).catch(() => {});
    }
    throw err;
  }
}

async function rollbackInstall(ctx: JobContext, ledger: InstallLedger): Promise<void> {
  // Integrations first (cheap), then services.
  for (const id of ledger.installedIntegrationIds) {
    try {
      coreRemoveIntegration({ rootDir: ROOT_DIR, id });
      await db.delete(installedIntegration).where(eq(installedIntegration.id, id));
    } catch (e) {
      await ctx
        .log(`Rollback: failed to remove integration ${id}: ${(e as Error).message}`, "stderr")
        .catch(() => {});
    }
  }
  for (const backup of ledger.previousIntegrations) {
    try {
      restoreInstalledIntegration(ROOT_DIR, backup);
    } catch (error) {
      await ctx
        .log(
          `Rollback: failed to restore integration ${backup.id}: ${(error as Error).message}`,
          "stderr",
        )
        .catch(() => {});
    }
  }
  if (ledger.installedIntegrationIds.length > 0 || ledger.previousIntegrations.length > 0) {
    await reloadIntegrations().catch(() => {});
  }

  if (ledger.enabledServiceIds.length > 0) {
    for (const svc of ledger.enabledServiceIds) {
      const removed = await dockerComposeAction(svc, "remove", {
        operationKey: createDurableOpsKey("extension.service.rollback", `${ctx.jobId}:${svc}`),
      });
      if (removed.exitCode !== 0) {
        throw new Error(`Community runtime rollback failed for ${svc}`);
      }
    }
  }
  let removedAllNewRepos = true;
  for (const hash of ledger.addedRepoHashes) {
    try {
      await removeRepo(hash);
    } catch (error) {
      removedAllNewRepos = false;
      await ctx
        .log(
          `Rollback: failed to remove service repository ${hash}: ${(error as Error).message}`,
          "stderr",
        )
        .catch(() => {});
    }
  }
  if (removedAllNewRepos) {
    for (const journal of ledger.newRepoPreparationJournals) {
      try {
        discardRepoPreparation(journal);
      } catch {
        // Startup reconciliation can safely finish this cleanup.
      }
    }
  }
  for (const backup of ledger.previousServiceRepos) {
    await restoreRepo(backup).catch((error) => {
      ctx
        .log(
          `Rollback: failed to restore service repository ${backup.snapshot.url}: ${(error as Error).message}`,
          "stderr",
        )
        .catch(() => {});
    });
  }
  if (ledger.touchedServiceIds.length > 0 && ledger.selectedRootsBefore) {
    try {
      await initServiceRegistry();
      await applySelectionRoots(
        ledger.selectedRootsBefore,
        false,
        createDurableOpsKey("extension.selection.rollback", ctx.jobId),
        ctx.signal,
      );
      await renderAndPersistCompose({
        operationKey: createDurableOpsKey("extension.rollback.render", ctx.jobId),
        signal: ctx.signal,
      });
      for (const serviceId of ledger.previouslyEnabledServiceIds) {
        await serviceStart(serviceId, ctx);
      }
    } catch (error) {
      await ctx
        .log(`Rollback: failed to restore service state: ${(error as Error).message}`, "stderr")
        .catch(() => {});
    }
  }
}

/**
 * Remove an installed extension — uninstall exactly the components it placed,
 * then delete the parent record (which cascades the component links).
 */
export async function removeExtension(
  ctx: JobContext,
  id: string,
): Promise<{ id: string; removed: number }> {
  const [ext] = await db
    .select()
    .from(installedExtension)
    .where(eq(installedExtension.id, id))
    .limit(1);
  if (!ext) throw new Error(`Extension "${id}" is not installed`);

  const components = await db
    .select()
    .from(installedExtensionComponent)
    .where(eq(installedExtensionComponent.extensionId, id));

  const serviceIds = components.filter((c) => c.kind === "service").map((c) => c.componentId);
  const integrationIds = components
    .filter((c) => c.kind === "integration")
    .map((c) => c.componentId);

  await ctx.setProgress(10);

  // Tear down service containers while they're still in the compose file.
  for (const svc of serviceIds) {
    await ctx.log(`Removing service container ${svc}...`);
    const removed = await dockerComposeAction(svc, "remove", {
      operationKey: createDurableOpsKey("extension.service.remove", `${ctx.jobId}:${svc}`),
      signal: ctx.signal,
    }).catch(() => ({ exitCode: 1 }));
    if (removed.exitCode !== 0) {
      throw new Error(`Failed to remove community service runtime ${svc}`);
    }
  }
  // Remove the repos this extension owns + drop the services from selection.
  if (serviceIds.length > 0) {
    try {
      await disableServicesInSelection(
        serviceIds,
        createDurableOpsKey("extension.selection.disable", `${ctx.jobId}:${id}`),
        ctx.signal,
      );
    } catch (e) {
      await ctx.log(`Failed to disable services: ${(e as Error).message}`, "stderr");
    }
    const repos = await db
      .select()
      .from(serviceRepository)
      .where(eq(serviceRepository.managedByExtension, id));
    for (const repo of repos) {
      await ctx.log(`Removing service repo ${repo.url}...`);
      await removeRepo(repo.hash).catch(() => {});
    }
    // disableServicesInSelection already applied the reduced enabled set in
    // memory; re-render to drop the service from compose (no registry re-init,
    // which would re-read the stale baked env).
    await renderAndPersistCompose({
      operationKey: createDurableOpsKey("extension.remove.render", `${ctx.jobId}:${id}`),
      signal: ctx.signal,
    }).catch(() => {});
  }
  await ctx.setProgress(60);

  // Remove integrations.
  for (const intgId of integrationIds) {
    await ctx.log(`Removing integration ${intgId}...`);
    try {
      coreRemoveIntegration({ rootDir: ROOT_DIR, id: intgId });
    } catch (e) {
      await ctx.log(
        `Failed to remove integration files for ${intgId}: ${(e as Error).message}`,
        "stderr",
      );
    }
    await db
      .delete(installedIntegration)
      .where(
        and(eq(installedIntegration.id, intgId), eq(installedIntegration.managedByExtension, id)),
      );
  }
  if (integrationIds.length > 0) {
    await reloadIntegrations().catch(() => {});
  }
  await ctx.setProgress(90);

  await db.delete(installedExtension).where(eq(installedExtension.id, id));
  await ctx.setProgress(100);
  await ctx.log(`Extension "${id}" removed (${components.length} component(s)).`);
  return { id, removed: components.length };
}

// Job handlers (wired in server.ts).

export async function handleExtensionInstallJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    manifest?: ExtensionManifest;
    sourceUrl?: string;
    sourceTrust?: ExtensionTrust;
    actorId?: string;
  };
  if (!payload.manifest) throw new Error("extension install job is missing manifest");
  const validation = coreServices.validateExtensionManifest(payload.manifest);
  if (!validation.valid) {
    throw new Error(`Invalid extension manifest: ${validation.errors.join("; ")}`);
  }
  return installExtension(ctx, {
    manifest: payload.manifest,
    sourceUrl: payload.sourceUrl,
    sourceTrust: payload.sourceTrust ?? "community",
    actorId: payload.actorId,
  });
}

export async function handleExtensionRemoveJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { id } = ctx.payload as { id: string };
  if (!id) throw new Error("extension remove job is missing id");
  return removeExtension(ctx, id);
}
