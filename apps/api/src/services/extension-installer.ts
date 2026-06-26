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
import { dockerComposeAction } from "../utils/docker-compose";
import {
  getServiceSelectionSummary,
  validateServiceSelectionForWrite,
  writeServiceSelection,
} from "./admin-cli";
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

/** Add service ids to the file-based selection. Returns the ids newly added. */
function enableServicesInSelection(serviceIds: string[]): string[] {
  const registry = getServiceRegistry();
  const summary = getServiceSelectionSummary(registry);
  const roots = [...summary.selectedRoots];
  const added: string[] = [];
  for (const id of serviceIds) {
    if (!roots.includes(id)) {
      roots.push(id);
      added.push(id);
    }
  }
  if (added.length > 0) {
    const { normalized } = validateServiceSelectionForWrite(registry, roots);
    writeServiceSelection(normalized);
  }
  return added;
}

function disableServicesInSelection(serviceIds: string[]): void {
  const registry = getServiceRegistry();
  const summary = getServiceSelectionSummary(registry);
  const roots = summary.selectedRoots.filter((r) => !serviceIds.includes(r));
  const { normalized } = validateServiceSelectionForWrite(registry, roots);
  writeServiceSelection(normalized);
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

    // 2. Reload the registry so the freshly-cloned services are loadable, then
    // enable them in the selection and reload again to apply.
    if (serviceComponents.length > 0) {
      await initServiceRegistry();
      const newlyEnabled = enableServicesInSelection(serviceComponents.map((s) => s.service));
      ledger.enabledServiceIds.push(...newlyEnabled);
      await initServiceRegistry();

      await ctx.log("Rendering compose...");
      await renderAndPersistCompose();
      for (const svc of serviceComponents) {
        await serviceStart(svc.service, ctx);
      }
    }
    await ctx.setProgress(60);

    // 3. Install each integration artifact, then hot-reload once.
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

      const now = new Date();
      await db
        .insert(installedIntegration)
        .values({
          id: intg.id,
          repository: opts.sourceUrl ?? intg.artifact,
          installedVersion: manifest.version,
          sourceType: "registry",
          installedAt: now,
          updatedAt: now,
          installedBy: opts.actorId ?? null,
          managedByExtension: manifest.id,
        })
        .onConflictDoUpdate({
          target: installedIntegration.id,
          set: {
            repository: opts.sourceUrl ?? intg.artifact,
            installedVersion: manifest.version,
            sourceType: "registry",
            updatedAt: now,
            managedByExtension: manifest.id,
          },
        });
    }
    if (integrationComponents.length > 0) {
      await ctx.log("Reloading integrations...");
      const r = await reloadIntegrations();
      await ctx.log(`Reload complete: ${r.reloaded} reloaded, ${r.enabled} enabled`);
    }
    await ctx.setProgress(90);

    // 4. Record the parent + component links (idempotent for update/re-install).
    const now = new Date();
    await db
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
        installedBy: opts.actorId ?? null,
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

    await db
      .delete(installedExtensionComponent)
      .where(eq(installedExtensionComponent.extensionId, manifest.id));
    const components = coreServices.extensionComponentSummary(manifest);
    if (components.length > 0) {
      await db.insert(installedExtensionComponent).values(
        components.map((c) => ({
          extensionId: manifest.id,
          kind: c.kind,
          componentId: c.id,
        })),
      );
    }

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
      await dockerComposeAction(svc, "remove").catch(() => ({ exitCode: 1, stdout: "" }));
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
    await initServiceRegistry().catch(() => {});
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
    await dockerComposeAction(svc, "remove").catch(() => ({ exitCode: 1, stdout: "" }));
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
    await initServiceRegistry().catch(() => {});
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
