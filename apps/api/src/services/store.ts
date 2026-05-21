import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { USER_AGENT_ADMIN, validatePublicUrl } from "@openmapx/core";
import { findRepoRoot } from "@openmapx/core/server";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/integration-framework";
import {
  installIntegration as coreInstallIntegration,
  removeIntegration as coreRemoveIntegration,
} from "@openmapx/integration-framework/installer";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { installedIntegration } from "../db/schema";
import { reloadIntegrations } from "../integration-host";
import { redis } from "../redis";
import type { JobContext } from "./job-runner";

// Single sentinel-based root resolver shared with the CLI. Honours
// OPENMAPX_ROOT_DIR and falls back to walking up from the current working
// directory looking for the workspace marker + an OpenMapX subdirectory.
export const ROOT_DIR = findRepoRoot();

// Catalog

const DEFAULT_CATALOG_URL =
  process.env.STORE_CATALOG_URL ??
  "https://raw.githubusercontent.com/openmapx/community-integrations/main/catalog.json";

const CATALOG_CACHE_KEY = "store:catalog";
const CATALOG_CACHE_TTL = 60 * 60 * 24; // 24 hours

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  artifact?: {
    url: string;
    sha256?: string;
  };
  version: string;
  minPlatform: string;
  domains: string[];
  quality: "community-verified" | "community";
  tags: string[];
  lastUpdated: string;
}

export interface CatalogSource {
  url: string;
  label: string;
  isDefault: boolean;
}

const EXTRA_SOURCES_CACHE_KEY = "store:extra_sources";

async function getExtraSources(): Promise<CatalogSource[]> {
  if (!redis) return [];
  try {
    const raw = await redis.get(EXTRA_SOURCES_CACHE_KEY);
    return raw ? (JSON.parse(raw) as CatalogSource[]) : [];
  } catch {
    return [];
  }
}

export async function addCatalogSource(url: string, label: string): Promise<void> {
  if (!redis) return;

  validatePublicUrl(url);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Catalog source must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Catalog source URL must not contain credentials");
  }

  const existing = await getExtraSources();
  if (existing.some((s) => s.url === url)) return;
  existing.push({ url, label, isDefault: false });
  await redis.set(EXTRA_SOURCES_CACHE_KEY, JSON.stringify(existing));
}

export async function removeCatalogSource(url: string): Promise<void> {
  if (!redis) return;
  const existing = await getExtraSources();
  const filtered = existing.filter((s) => s.url !== url);
  await redis.set(EXTRA_SOURCES_CACHE_KEY, JSON.stringify(filtered));
}

export async function listCatalogSources(): Promise<CatalogSource[]> {
  const defaults: CatalogSource[] = [
    { url: DEFAULT_CATALOG_URL, label: "OpenMapX Community", isDefault: true },
  ];
  const extras = await getExtraSources();
  return [...defaults, ...extras];
}

async function fetchCatalogFromUrl(url: string): Promise<CatalogEntry[]> {
  validatePublicUrl(url);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT_ADMIN },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Catalog fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Catalog response is not an array");
  return data as CatalogEntry[];
}

export async function getCatalog(forceRefresh = false): Promise<CatalogEntry[]> {
  if (!forceRefresh && redis) {
    try {
      const cached = await redis.get(CATALOG_CACHE_KEY);
      if (cached) return JSON.parse(cached) as CatalogEntry[];
    } catch {
      // cache miss
    }
  }

  const sources = await listCatalogSources();
  const allEntries: CatalogEntry[] = [];
  const seenIds = new Set<string>();

  for (const source of sources) {
    try {
      const entries = await fetchCatalogFromUrl(source.url);
      for (const entry of entries) {
        if (!seenIds.has(entry.id)) {
          seenIds.add(entry.id);
          allEntries.push(entry);
        }
      }
    } catch (err) {
      console.warn(`[store] Failed to fetch catalog from ${source.url}:`, err);
    }
  }

  if (redis && allEntries.length > 0) {
    redis.setex(CATALOG_CACHE_KEY, CATALOG_CACHE_TTL, JSON.stringify(allEntries)).catch(() => {});
  }

  return allEntries;
}

export async function getCatalogEntry(id: string): Promise<CatalogEntry | null> {
  const catalog = await getCatalog();
  return catalog.find((e) => e.id === id) ?? null;
}

export async function fetchReadme(repository: string): Promise<string | null> {
  try {
    const match = repository.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    const [, owner, repo] = match;
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Update check

export interface UpdateInfo {
  id: string;
  installedVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

/**
 * An installed integration is only "manageable" through the catalog when it
 * was first installed from the catalog *and* still resolves to the same
 * repository. A different repo means the catalog and the installed copy have
 * drifted and the user would lose customizations on update.
 */
export function canUpdateFromCatalog(
  installed: { sourceType: string; repository: string },
  catalogEntry: { repository: string } | undefined | null,
): boolean {
  return (
    !!catalogEntry &&
    installed.sourceType === "registry" &&
    installed.repository === catalogEntry.repository
  );
}

export async function checkForUpdates(): Promise<UpdateInfo[]> {
  const [installed, catalog] = await Promise.all([
    db.select().from(installedIntegration),
    getCatalog(),
  ]);

  const catalogMap = new Map(catalog.map((e) => [e.id, e]));
  return installed.map((inst) => {
    const entry = catalogMap.get(inst.id);
    const canUseCatalog = canUpdateFromCatalog(inst, entry);
    return {
      id: inst.id,
      installedVersion: inst.installedVersion,
      latestVersion: canUseCatalog
        ? (entry?.version ?? inst.installedVersion)
        : inst.installedVersion,
      hasUpdate: canUseCatalog && entry !== undefined && entry.version !== inst.installedVersion,
    };
  });
}

// Job handlers
//
// Install/update/remove all delegate to `@openmapx/core`'s installer (the same
// code path the `pnpm openmapx integrations` CLI uses). Job-runner wiring
// (progress, logs, abort signal) lives here; the actual filesystem + tar work
// lives in core.
//
// Admin installs only ever take prebuilt artifacts: either a catalog entry
// (`sourceType: registry`) with an `artifact.url`, or a manually-pasted
// HTTPS `.tar.gz` URL (`sourceType: artifact`). Git source installs are a
// CLI-only developer workflow — the api process never builds.

interface InstallJobPayload {
  artifactUrl: string;
  artifactSha256?: string;
  // Repository field is preserved purely for catalog identification + display.
  // It is *not* used to install; the artifactUrl is the source of truth.
  repository: string;
  installedVersion: string;
  sourceType: "registry" | "artifact";
  actorId?: string;
}

async function runArtifactInstall(
  ctx: JobContext,
  artifactUrl: string,
  artifactSha256: string | undefined,
): Promise<{ id: string; directory: string; replaced: boolean }> {
  return coreInstallIntegration({
    rootDir: ROOT_DIR,
    source: artifactUrl,
    sourceKind: "artifact",
    artifactSha256,
    // No local paths from the HTTP surface. CLI-only.
    allowLocalSources: false,
    signal: ctx.signal,
    onLog: (line, stream) => {
      ctx.log(line, stream).catch(() => {});
    },
  });
}

const VERSION_REF_REGEX = /^[a-zA-Z0-9._\-/]+$/;

function assertValidVersion(version: string | undefined): void {
  if (version && !VERSION_REF_REGEX.test(version)) {
    throw new Error(`Invalid version format: "${version}"`);
  }
}

export async function handleInstallJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as Partial<InstallJobPayload>;
  if (!payload.artifactUrl) {
    throw new Error("install job is missing artifactUrl");
  }
  const sourceType: "registry" | "artifact" = payload.sourceType ?? "artifact";
  const installedVersion = payload.installedVersion ?? "unknown";
  assertValidVersion(installedVersion);

  await ctx.log(`Installing integration artifact from ${payload.artifactUrl}...`);
  await ctx.setProgress(10);
  const installed = await runArtifactInstall(ctx, payload.artifactUrl, payload.artifactSha256);
  await ctx.setProgress(70);

  await ctx.log("Reloading integrations...");
  const reloadResult = await reloadIntegrations();
  await ctx.log(
    `Reload complete: ${reloadResult.reloaded} reloaded, ${reloadResult.enabled} enabled`,
  );
  await ctx.setProgress(90);

  // Sanity-check the manifest id matches what the installer told us — it should
  // always agree because the installer reads the manifest itself, but logging
  // a warning here makes drift detectable.
  let integrationId = installed.id;
  const manifestPath = join(installed.directory, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string };
      if (manifest.id && manifest.id !== installed.id) {
        await ctx.log(
          `Warning: manifest id ${manifest.id} differs from installed id ${installed.id}`,
        );
        integrationId = manifest.id;
      }
    } catch {
      // not fatal — installed.id from the installer is authoritative
    }
  }

  const now = new Date();
  await db
    .insert(installedIntegration)
    .values({
      id: integrationId,
      repository: payload.repository ?? payload.artifactUrl,
      installedVersion,
      sourceType,
      installedAt: now,
      updatedAt: now,
      installedBy: payload.actorId ?? null,
    })
    .onConflictDoUpdate({
      target: installedIntegration.id,
      set: {
        repository: payload.repository ?? payload.artifactUrl,
        installedVersion,
        sourceType,
        updatedAt: now,
        installedBy: payload.actorId ?? null,
      },
    });

  await ctx.setProgress(100);
  await ctx.log(`Integration ${integrationId} installed (restart app-api to load backend code).`);
  return { integrationId };
}

interface UpdateJobPayload {
  id: string;
  artifactUrl: string;
  artifactSha256?: string;
  installedVersion: string;
  actorId?: string;
}

export async function handleUpdateJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as Partial<UpdateJobPayload>;
  if (!payload.id) throw new Error("update job is missing id");
  if (!payload.artifactUrl) throw new Error("update job is missing artifactUrl");

  const [record] = await db
    .select()
    .from(installedIntegration)
    .where(eq(installedIntegration.id, payload.id))
    .limit(1);
  if (!record) throw new Error(`Integration ${payload.id} is not installed`);
  assertValidVersion(payload.installedVersion);

  await ctx.log(`Updating integration ${payload.id} from ${payload.artifactUrl}...`);
  await ctx.setProgress(10);
  await runArtifactInstall(ctx, payload.artifactUrl, payload.artifactSha256);
  await ctx.setProgress(70);

  await ctx.log("Reloading integrations...");
  const reloadResult = await reloadIntegrations();
  await ctx.log(
    `Reload complete: ${reloadResult.reloaded} reloaded, ${reloadResult.enabled} enabled`,
  );
  await ctx.setProgress(90);

  await db
    .update(installedIntegration)
    .set({
      installedVersion: payload.installedVersion ?? "unknown",
      updatedAt: new Date(),
      installedBy: payload.actorId ?? null,
    })
    .where(eq(installedIntegration.id, payload.id));

  await ctx.setProgress(100);
  await ctx.log(`Integration ${payload.id} updated (restart app-api to load backend code).`);
  return { integrationId: payload.id, version: payload.installedVersion ?? "unknown" };
}

export async function handleRemoveJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { id } = ctx.payload as { id: string; actorId?: string };

  await ctx.log(`Removing integration ${id}...`);
  await ctx.setProgress(5);

  coreRemoveIntegration({ rootDir: ROOT_DIR, id });
  await ctx.setProgress(70);

  await ctx.log("Reloading integrations...");
  const reloadResult = await reloadIntegrations();
  await ctx.log(
    `Reload complete: ${reloadResult.reloaded} reloaded, ${reloadResult.enabled} enabled`,
  );
  await ctx.setProgress(90);

  await db.delete(installedIntegration).where(eq(installedIntegration.id, id));

  await ctx.setProgress(100);
  await ctx.log(`Integration ${id} removed successfully.`);
  return { integrationId: id };
}

// Platform compatibility

export function isCompatible(entry: CatalogEntry): boolean {
  if (!entry.minPlatform) return true;
  return satisfiesPlatformVersion(entry.minPlatform);
}

export { PLATFORM_VERSION };
