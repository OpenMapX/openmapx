import { createHash, randomUUID } from "node:crypto";
import { services as coreServices, findRepoRoot } from "@openmapx/core/server";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/integration-framework";
import {
  installIntegration as coreInstallIntegration,
  removeIntegration as coreRemoveIntegration,
  discardInstalledIntegrationBackup,
  type IntegrationPublication,
  type IntegrationRollbackBackup,
  restoreInstalledIntegration,
  settleIntegrationPublication,
} from "@openmapx/integration-framework/installer";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
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
import {
  inspectServiceRepository,
  publishServiceRepository,
  type RepositoryInspection,
  readCommunityServices,
  removeServiceRepository,
  settleServiceRepository,
} from "./community-repositories";
import { assertComponentOwnership } from "./extension-component-ownership";
import {
  appendIntegrationJournalEntry,
  createExtensionInstallJournal,
  type ExtensionInstallJournal,
  markExtensionInstallJournalRestoring,
  markIntegrationJournalEntryInstalled,
  reconcileExtensionInstallJournal,
  recordIntegrationPublicationPrepared,
} from "./extension-install-journal";
import { recoverInterruptedExtensionChanges, withExtensionChangeLock } from "./extension-recovery";
import { getKillSwitch } from "./extension-store";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";
import {
  communityServiceRepository,
  getServiceRegistry,
  initServiceRegistry,
} from "./service-registry";
import { applyTrustedConfiguration } from "./trusted-config-operations";
import {
  isProvenConfigurationNonCommit,
  TrustedConfigurationApplyError,
} from "./trusted-config-outcome";

type ExtensionManifest = coreServices.ExtensionManifest;
const ROOT_DIR = findRepoRoot();

export type ExtensionTrust = "built-in" | "verified" | "community";

export interface InstallExtensionOptions {
  manifest: ExtensionManifest;
  /** Catalog/source URL the bundle came from (null for raw install-by-manifest). */
  sourceUrl?: string;
  sourceTrust: ExtensionTrust;
  actorId?: string;
  /** Fingerprint returned by previewExtensionInstall for the exact port-bearing snapshot. */
  hostPortConfirmation?: string;
}

export interface ExtensionInstallServicePreview {
  id: string;
  name: string;
  version: string;
  repositoryCommit: string;
  hostPorts: Array<{
    host: number;
    container: number;
    protocol: "tcp" | "udp";
    bindAddress: string;
  }>;
  securityRating: coreServices.ServiceSecurityRating;
}

export interface ExtensionInstallPreview {
  extension: { id: string; name: string; version: string };
  sourceTrust: ExtensionTrust;
  services: ExtensionInstallServicePreview[];
  requiresHostPortConfirmation: boolean;
  confirmation: string;
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildExtensionInstallPreview(
  opts: InstallExtensionOptions,
  inspections: ReadonlyMap<string, RepositoryInspection>,
): ExtensionInstallPreview {
  const services = (opts.manifest.services ?? [])
    .map((component): ExtensionInstallServicePreview => {
      const inspection = inspections.get(component.repo);
      if (!inspection) {
        throw new ExtensionPreflightError(
          `Extension service "${component.service}" has no inspected repository`,
        );
      }
      const service = inspection.services.find(
        (candidate) => candidate.manifest.id === component.service,
      );
      if (!service) {
        throw new ExtensionPreflightError(
          `Extension service "${component.service}" was not found in its validated repository`,
        );
      }
      const { manifest } = service;
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        repositoryCommit: inspection.commit,
        hostPorts: (manifest.exposure?.hostPorts ?? []).map((port) => ({
          host: port.host,
          container: port.container,
          protocol: port.protocol ?? "tcp",
          // Must match the community default in renderServiceSnippet.
          bindAddress: port.bindAddress ?? "127.0.0.1",
        })),
        securityRating: coreServices.computeServiceSecurityRating(manifest),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const confirmation = createHash("sha256")
    .update(
      canonicalJson({
        manifest: opts.manifest,
        sourceTrust: opts.sourceTrust,
        services,
      }),
    )
    .digest("hex");

  return {
    extension: {
      id: opts.manifest.id,
      name: opts.manifest.name,
      version: opts.manifest.version,
    },
    sourceTrust: opts.sourceTrust,
    services,
    requiresHostPortConfirmation: services.some((service) => service.hostPorts.length > 0),
    confirmation,
  };
}

/**
 * Have the operations agent fetch and validate every service repository the
 * extension names. An inspection pins each ref to an exact commit; installing
 * fetches that commit again, so a mutable ref cannot change what is installed.
 */
async function inspectExtensionServiceRepos(
  opts: InstallExtensionOptions,
  scope: { namespace: string; identity: string },
  signal?: AbortSignal,
): Promise<Map<string, RepositoryInspection>> {
  const inspections = new Map<string, RepositoryInspection>();
  for (const component of opts.manifest.services ?? []) {
    if (inspections.has(component.repo)) continue;
    const inspection = await inspectServiceRepository(component.repo, component.ref, {
      operationKey: createDurableOpsKey(scope.namespace, `${scope.identity}:${component.repo}`),
      signal,
    });
    if (!inspection.valid) {
      throw new ExtensionPreflightError(
        `Service repository ${inspection.url} was rejected: ${inspection.problems.join("; ")}`,
      );
    }
    inspections.set(component.repo, inspection);
  }
  return inspections;
}

/** Fetch and inspect exact service snapshots without installing or starting them. */
export async function previewExtensionInstall(
  opts: InstallExtensionOptions,
): Promise<ExtensionInstallPreview> {
  await preflightExtensionInstall(opts);
  await assertNotRevoked(opts.manifest.id);
  const inspections = await inspectExtensionServiceRepos(opts, {
    namespace: "extension.preview.inspect",
    identity: randomUUID(),
  });
  return buildExtensionInstallPreview(opts, inspections);
}

/**
 * Revocation is authoritative at execution time, not at queue time. A denial
 * published while the job waited must still stop the install.
 */
async function assertNotRevoked(extensionId: string): Promise<void> {
  const kill = await getKillSwitch();
  const removed = kill.removed.get(extensionId);
  if (removed !== undefined) {
    throw new ExtensionPreflightError(`Extension "${extensionId}" is delisted: ${removed}`);
  }
  const critical = kill.critical.get(extensionId);
  if (critical) {
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

async function integrationInstalledExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: installedIntegration.id })
    .from(installedIntegration)
    .where(eq(installedIntegration.id, id))
    .limit(1);
  return !!row;
}

/**
 * Make `roots` the operator's selection and apply it: the ops-agent writes
 * `service-selection.json`, which the CLI renders too, and the registry of the
 * running API follows the applied generation without a restart.
 */
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
}

/** Add service ids to the selection. Returns the ids newly added. */
async function enableServicesInSelection(
  serviceIds: string[],
  operationKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const registry = getServiceRegistry();
  const roots = [...(await getServiceSelectionSummary(registry)).selectedRoots];
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
  const roots = (await getServiceSelectionSummary(registry)).selectedRoots.filter(
    (r) => !serviceIds.includes(r),
  );
  await applySelectionRoots(roots, true, operationKey, signal);
}

interface InstallLedger {
  /** Repository transactions this run opened in the operations agent. */
  publishedRepositories: Array<{ repository: string; transactionId: string }>;
  enabledServiceIds: string[]; // services newly enabled this run
  installedIntegrationIds: string[]; // integrations newly installed this run
  previousIntegrations: IntegrationRollbackBackup[];
  publishedIntegrations: Array<{ id: string; publication: IntegrationPublication }>;
  touchedServiceIds: string[];
  previouslyEnabledServiceIds: string[];
  selectedRootsBefore: string[] | null;
}

/**
 * Orchestrated, atomic-ish install of an extension bundle. The operations
 * agent installs each service repository as a transaction it can undo;
 * compose render/start and integration artifact install + hot reload follow,
 * and one `installed_extension` parent records the bundle so it removes and
 * updates as a unit. The database transaction is the commit point. On any
 * failure before it, the steps completed this run are rolled back
 * best-effort; parts that pre-existed are left untouched. Extension changes run
 * one at a time, after recovering any change an earlier crash interrupted.
 */
export function installExtension(
  ctx: JobContext,
  opts: InstallExtensionOptions,
): Promise<{ id: string; components: number }> {
  return withExtensionChangeLock(async () => {
    await recoverInterruptedExtensionChanges(ctx.signal);
    return installExtensionNow(ctx, opts);
  });
}

async function installExtensionNow(
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
  await assertNotRevoked(manifest.id);

  const ledger: InstallLedger = {
    publishedRepositories: [],
    enabledServiceIds: [],
    installedIntegrationIds: [],
    previousIntegrations: [],
    publishedIntegrations: [],
    touchedServiceIds: [],
    previouslyEnabledServiceIds: [],
    selectedRootsBefore: null,
  };
  let bookkeepingCommitted = false;
  let rollbackRequired = false;
  let integrationJournal: ExtensionInstallJournal | null = null;

  try {
    const serviceComponents = manifest.services ?? [];
    const integrationComponents = manifest.integrations ?? [];
    const pendingServiceRepoRows: Array<typeof serviceRepository.$inferInsert> = [];
    // Repository URL -> what this install actually published for it, so a
    // component's provenance is checked against the agent's answer rather than
    // against a re-derived identifier.
    const publishedByRepo = new Map<string, { repository: string; serviceIds: string[] }>();
    // Validated by preflight: one ref per repository.
    const serviceRepos = new Map<string, (typeof serviceComponents)[number]>();
    for (const component of serviceComponents) serviceRepos.set(component.repo, component);

    if (serviceComponents.length > 0) {
      const registry = getServiceRegistry();
      ledger.selectedRootsBefore = [...(await getServiceSelectionSummary(registry)).selectedRoots];
      ledger.touchedServiceIds = serviceComponents.map((component) => component.service);
      ledger.previouslyEnabledServiceIds = ledger.touchedServiceIds.filter(
        (serviceId) => registry.get(serviceId)?.enabled === true,
      );
    }

    // Pin every repository to the exact commit the security preview describes.
    const inspections = await inspectExtensionServiceRepos(
      opts,
      { namespace: "extension.install.inspect", identity: `${ctx.jobId}:${manifest.id}` },
      ctx.signal,
    );
    const installPreview = buildExtensionInstallPreview(opts, inspections);
    if (
      installPreview.requiresHostPortConfirmation &&
      opts.hostPortConfirmation !== installPreview.confirmation
    ) {
      throw new ExtensionPreflightError(
        "Community service host ports require a fresh security preview and explicit confirmation",
      );
    }

    // 1. Install every repository at its inspected commit. The agent keeps each
    // previous checkout, and this run's recovery note, until the change settles.
    for (const svc of serviceRepos.values()) {
      const inspection = inspections.get(svc.repo);
      if (!inspection) throw new Error(`Service repository "${svc.repo}" was not inspected`);
      await ctx.log(`Installing service repository ${inspection.url}@${inspection.commit}...`);
      const published = await publishServiceRepository(
        {
          url: inspection.url,
          commit: inspection.commit,
          ref: svc.ref ?? "HEAD",
          extensionId: manifest.id,
          recovery: {
            selectionBefore: ledger.selectedRootsBefore,
            touchedServiceIds: ledger.touchedServiceIds,
            previouslyEnabledServiceIds: ledger.previouslyEnabledServiceIds,
          },
        },
        {
          operationKey: createDurableOpsKey(
            "extension.repository.publish",
            `${ctx.jobId}:${manifest.id}:${inspection.repository}`,
          ),
          signal: ctx.signal,
        },
      );
      rollbackRequired = true;
      ledger.publishedRepositories.push({
        repository: published.repository,
        transactionId: published.transactionId,
      });
      publishedByRepo.set(svc.repo, {
        repository: published.repository,
        serviceIds: published.serviceIds,
      });
      pendingServiceRepoRows.push({
        hash: published.repository,
        url: inspection.url,
        lastSha: published.commit,
        pinnedRef: svc.ref ?? null,
        managedByExtension: manifest.id,
        lastTransactionId: published.transactionId,
      });
    }
    await ctx.setProgress(25);

    // 2. Reload the registry so the freshly installed services appear in
    // list(), then enable them in-memory (applySelectionRoots also persists the
    // file). Do NOT re-init after enabling — that re-reads the stale baked env
    // list.
    if (serviceComponents.length > 0) {
      await initServiceRegistry({ strict: true });
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
        // The service must come from the repository this install published
        // for it, as the agent reports both, before it can be linked.
        const provenance = publishedByRepo.get(component.repo);
        if (
          !provenance ||
          !provenance.serviceIds.includes(component.service) ||
          communityServiceRepository(component.service) !== provenance.repository
        ) {
          throw new Error(
            `Extension service "${component.service}" was not installed from its declared repository`,
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
      appendIntegrationJournalEntry(integrationJournal, {
        id: intg.id,
        backupDirectory: null,
        transactional: true,
      });
      await ctx.log(`Installing integration ${intg.id} from ${intg.artifact}...`);
      const installed = await coreInstallIntegration({
        rootDir: ROOT_DIR,
        expectedId: intg.id,
        retainPublication: true,
        beforePublish: (receipt) =>
          recordIntegrationPublicationPrepared(integrationJournal!, intg.id, receipt),
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
      if (!installed.publication)
        throw Error("Integration publisher did not retain its original transaction");
      ledger.publishedIntegrations.push({ id: intg.id, publication: installed.publication });
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
    await assertNotRevoked(manifest.id);
    await assertComponentOwnership(manifest.id, components);
    await db.transaction(async (tx) => {
      for (const row of pendingServiceRepoRows) {
        await tx
          .insert(serviceRepository)
          .values(row)
          .onConflictDoUpdate({
            target: serviceRepository.hash,
            set: {
              lastSha: row.lastSha,
              pinnedRef: row.pinnedRef,
              managedByExtension: row.managedByExtension,
              lastTransactionId: row.lastTransactionId,
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
    // The install is committed; let the agent drop the previous checkouts. A
    // failure here leaves the transaction pending, and recovery commits it.
    for (const { repository, transactionId } of ledger.publishedRepositories) {
      try {
        const settled = await settleServiceRepository(
          { repository, transactionId, outcome: "commit" },
          {
            operationKey: createDurableOpsKey(
              "extension.repository.commit",
              `${ctx.jobId}:${repository}:${transactionId}`,
            ),
            signal: ctx.signal,
          },
        );
        // Only another recovery can have settled it first; its checkout may no
        // longer be the commit just recorded.
        if (!settled.changed) {
          await ctx
            .log(
              `The operations agent no longer held the installed change for repository ${repository}; reinstall extension "${manifest.id}" to make sure it runs the recorded commit.`,
              "stderr",
            )
            .catch(() => {});
        }
      } catch (error) {
        await ctx
          .log(
            `Cleanup: the operations agent could not settle repository ${repository}: ${(error as Error).message}`,
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
    if (err instanceof TrustedConfigurationApplyError && !isProvenConfigurationNonCommit(err))
      throw err;
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
  // Only the exact held publication may restore its previous directory.
  for (const entry of [...ledger.publishedIntegrations].reverse())
    await settleIntegrationPublication(entry.publication, "restore", new AbortController().signal);
  // Historical entries retain their existing recovery path.
  for (const id of ledger.installedIntegrationIds) {
    if (ledger.publishedIntegrations.some((entry) => entry.id === id)) continue;
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
  if (
    ledger.publishedIntegrations.length > 0 ||
    ledger.installedIntegrationIds.length > 0 ||
    ledger.previousIntegrations.length > 0
  ) {
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
  // Newest first: the agent restores each previous checkout, or removes a
  // repository this run added, and keeps this run's recovery note.
  const rolledBack: InstallLedger["publishedRepositories"] = [];
  for (const transaction of [...ledger.publishedRepositories].reverse()) {
    try {
      await settleServiceRepository(
        { ...transaction, outcome: "rollback" },
        {
          operationKey: createDurableOpsKey(
            "extension.repository.rollback",
            `${ctx.jobId}:${transaction.repository}:${transaction.transactionId}`,
          ),
        },
      );
      rolledBack.push(transaction);
    } catch (error) {
      await ctx
        .log(
          `Rollback: the operations agent could not restore repository ${transaction.repository}: ${(error as Error).message}`,
          "stderr",
        )
        .catch(() => {});
    }
  }
  // With the previous checkouts back, restore the selection and runtimes. The
  // agent drops the recovery notes only after that succeeds; otherwise the
  // next recovery finishes the job from them.
  if (ledger.touchedServiceIds.length > 0 && ledger.selectedRootsBefore) {
    try {
      await initServiceRegistry({ strict: true });
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
      return;
    }
  }
  for (const transaction of rolledBack) {
    try {
      await settleServiceRepository(
        { ...transaction, outcome: "release" },
        {
          operationKey: createDurableOpsKey(
            "extension.repository.release",
            `${ctx.jobId}:${transaction.repository}:${transaction.transactionId}`,
          ),
        },
      );
    } catch (error) {
      await ctx
        .log(
          `Rollback: the operations agent could not release repository ${transaction.repository}: ${(error as Error).message}`,
          "stderr",
        )
        .catch(() => {});
    }
  }
}

/**
 * Remove an installed extension — uninstall exactly the components it placed,
 * then delete the parent record (which cascades the component links).
 */
export function removeExtension(
  ctx: JobContext,
  id: string,
): Promise<{ id: string; removed: number }> {
  return withExtensionChangeLock(async () => {
    await recoverInterruptedExtensionChanges(ctx.signal);
    return removeExtensionNow(ctx, id);
  });
}

async function removeExtensionNow(
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

  // A removal interrupted after the agent deleted a repository is retried
  // without that repository's services: their runtimes went first, and the
  // agent, which no longer reports them at all, refuses to act on them.
  const reported =
    serviceIds.length > 0
      ? new Set((await readCommunityServices({ signal: ctx.signal })).reportedServiceIds)
      : new Set<string>();

  // Tear down service containers while they're still in the compose file.
  for (const svc of serviceIds.filter((id) => reported.has(id))) {
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
      throw e;
    }
    const repos = await db
      .select()
      .from(serviceRepository)
      .where(eq(serviceRepository.managedByExtension, id));
    // A repository the agent cannot remove fails the job before the extension
    // record is deleted, so the removal can be retried.
    for (const repo of repos) {
      await ctx.log(`Removing service repository ${repo.url}...`);
      await removeServiceRepository(
        { repository: repo.hash, extensionId: id },
        {
          operationKey: createDurableOpsKey(
            "extension.repository.remove",
            `${ctx.jobId}:${repo.hash}`,
          ),
          signal: ctx.signal,
        },
      );
      await db.delete(serviceRepository).where(eq(serviceRepository.hash, repo.hash));
    }
    // disableServicesInSelection already applied the reduced enabled set in
    // memory; re-render to drop the service from compose (no registry re-init,
    // which would re-read the stale baked env).
    await renderAndPersistCompose({
      operationKey: createDurableOpsKey("extension.remove.render", `${ctx.jobId}:${id}`),
      signal: ctx.signal,
    });
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
    hostPortConfirmation?: string;
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
    hostPortConfirmation: payload.hostPortConfirmation,
  });
}

export async function handleExtensionRemoveJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { id } = ctx.payload as { id: string };
  if (!id) throw new Error("extension remove job is missing id");
  return removeExtension(ctx, id);
}
