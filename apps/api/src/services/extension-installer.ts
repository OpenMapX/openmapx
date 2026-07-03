import { services as coreServices, findRepoRoot } from "@openmapx/core/server";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/integration-framework";
import {
  installIntegration as coreInstallIntegration,
  removeIntegration as coreRemoveIntegration,
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
import { getServiceSelectionSummary, writeServiceSelection } from "./admin-cli";
import { renderAndPersistCompose, serviceStart } from "./admin-ops";
import type { JobContext } from "./job-runner";
import { getServiceRegistry, initServiceRegistry } from "./service-registry";
import { hashUrl, registerRepo, removeRepo } from "./service-repositories";

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

async function serviceRepoExists(url: string): Promise<boolean> {
  const [row] = await db
    .select({ hash: serviceRepository.hash })
    .from(serviceRepository)
    .where(eq(serviceRepository.hash, hashUrl(url)))
    .limit(1);
  return !!row;
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
function applySelectionRoots(roots: string[], allowMissing: boolean): void {
  const registry = getServiceRegistry();
  const normalized = coreServices.normalizeServiceIds(roots);
  const expanded = coreServices.expandServiceSelection(registry.list(), normalized, {
    allowMissingSelected: allowMissing,
  });
  if (expanded.missingIds.length > 0) {
    throw new Error(`Selected service(s) are not installed: ${expanded.missingIds.join(", ")}`);
  }
  writeServiceSelection(normalized);
  registry.applyEnabledIds(expanded.enabledIds);
}

/** Add service ids to the selection. Returns the ids newly added. */
function enableServicesInSelection(serviceIds: string[]): string[] {
  const registry = getServiceRegistry();
  const roots = [...getServiceSelectionSummary(registry).selectedRoots];
  const added = serviceIds.filter((id) => !roots.includes(id));
  if (added.length === 0) return [];
  applySelectionRoots([...roots, ...added], false);
  return added;
}

function disableServicesInSelection(serviceIds: string[]): void {
  const registry = getServiceRegistry();
  const roots = getServiceSelectionSummary(registry).selectedRoots.filter(
    (r) => !serviceIds.includes(r),
  );
  applySelectionRoots(roots, true);
}

interface InstallLedger {
  addedRepoHashes: string[]; // repos newly cloned this run (eligible for rollback removal)
  enabledServiceIds: string[]; // services newly enabled this run
  installedIntegrationIds: string[]; // integrations newly installed this run
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

  if (manifest.platform && !satisfiesPlatformVersion(manifest.platform)) {
    throw new Error(
      `Extension "${manifest.id}" requires platform >= ${manifest.platform} (this is ${PLATFORM_VERSION}).`,
    );
  }

  const ledger: InstallLedger = {
    addedRepoHashes: [],
    enabledServiceIds: [],
    installedIntegrationIds: [],
  };

  try {
    const serviceComponents = manifest.services ?? [];
    const integrationComponents = manifest.integrations ?? [];

    // 1. Register + pin every service repo.
    for (const svc of serviceComponents) {
      const existed = await serviceRepoExists(svc.repo);
      await ctx.log(`Registering service repo ${svc.repo}${svc.ref ? `@${svc.ref}` : ""}...`);
      const row = await registerRepo(svc.repo, {
        ref: svc.ref,
        managedByExtension: manifest.id,
      });
      if (!existed) ledger.addedRepoHashes.push(row.hash);
    }
    await ctx.setProgress(25);

    // 2. Reload the registry so the freshly-cloned services appear in list(),
    // then enable them in-memory (applySelectionRoots also persists the file).
    // Do NOT re-init after enabling — that re-reads the stale baked env list.
    if (serviceComponents.length > 0) {
      await initServiceRegistry();
      const newlyEnabled = enableServicesInSelection(serviceComponents.map((s) => s.service));
      ledger.enabledServiceIds.push(...newlyEnabled);

      await ctx.log("Rendering compose...");
      await renderAndPersistCompose();
      for (const svc of serviceComponents) {
        // Pull first so a moving image tag (e.g. :latest) is refreshed on
        // update — `up -d` alone won't re-pull a tag already cached on the host,
        // so without this an updated extension would keep running the old image.
        // Best-effort: a pull failure (offline / locally-built image) falls
        // through to starting on the cached image.
        const pulled = await dockerComposeAction(svc.service, "pull");
        if (pulled.exitCode !== 0) {
          const reason = pulled.stderr.trim().split("\n").slice(-3).join("; ") || "unknown error";
          await ctx.log(
            `docker compose pull ${svc.service} failed (exit ${pulled.exitCode}): ${reason} — starting on the cached image (the container may keep running the previous version)`,
            "stderr",
          );
        }
        await serviceStart(svc.service, ctx);
      }
    }
    await ctx.setProgress(60);

    // 3. Install each integration artifact, then hot-reload once. The
    // bookkeeping rows are collected here and written in the step-4 transaction
    // so nothing is persisted until the whole record set can land atomically.
    const pendingIntegrationRows: Array<{ id: string; repository: string }> = [];
    for (const intg of integrationComponents) {
      const existed = await integrationInstalledExists(intg.id);
      await ctx.log(`Installing integration ${intg.id} from ${intg.artifact}...`);
      await coreInstallIntegration({
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
    await db.transaction(async (tx) => {
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

    await ctx.setProgress(100);
    await ctx.log(`Extension "${manifest.id}" installed (${components.length} component(s)).`);
    return { id: manifest.id, components: components.length };
  } catch (err) {
    await ctx.log(`Install failed: ${(err as Error).message}. Rolling back...`, "stderr");
    await rollbackInstall(ctx, ledger).catch((rbErr) => {
      ctx
        .log(`Rollback encountered an error: ${(rbErr as Error).message}`, "stderr")
        .catch(() => {});
    });
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
      await ctx.log(
        `Rollback: failed to remove integration ${id}: ${(e as Error).message}`,
        "stderr",
      );
    }
  }
  if (ledger.installedIntegrationIds.length > 0) {
    await reloadIntegrations().catch(() => {});
  }

  if (ledger.enabledServiceIds.length > 0) {
    for (const svc of ledger.enabledServiceIds) {
      await dockerComposeAction(svc, "remove").catch(() => ({
        exitCode: 1,
        stdout: "",
        stderr: "",
      }));
    }
    try {
      disableServicesInSelection(ledger.enabledServiceIds);
    } catch (e) {
      await ctx.log(`Rollback: failed to disable services: ${(e as Error).message}`, "stderr");
    }
  }
  for (const hash of ledger.addedRepoHashes) {
    await removeRepo(hash).catch(() => {});
  }
  if (ledger.enabledServiceIds.length > 0 || ledger.addedRepoHashes.length > 0) {
    // disableServicesInSelection already applied the reduced enabled set in
    // memory; just re-render. (No initServiceRegistry — it would re-read the
    // stale baked OPENMAPX_ENABLED_SERVICES and undo the disable.)
    await renderAndPersistCompose().catch(() => {});
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
    await dockerComposeAction(svc, "remove").catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  }
  // Remove the repos this extension owns + drop the services from selection.
  if (serviceIds.length > 0) {
    try {
      disableServicesInSelection(serviceIds);
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
    await renderAndPersistCompose().catch(() => {});
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
