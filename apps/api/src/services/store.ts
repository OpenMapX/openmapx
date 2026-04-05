import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/core";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { installedIntegration } from "../db/schema";
import { reloadIntegrations } from "../integration-host";
import { redis } from "../redis";
import { safeChildEnv } from "./admin-ops";
import type { JobContext } from "./job-runner";

// Path resolution

function findRootDir(): string {
  if (process.env.OPENMAPX_ROOT_DIR) return process.env.OPENMAPX_ROOT_DIR;
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "..", "..", "..", "..");
}

export const ROOT_DIR = findRootDir();
export const INTEGRATION_SH = join(ROOT_DIR, "scripts", "integration.sh");

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
  const res = await fetch(url, {
    headers: { "User-Agent": "OpenMapX-Admin/1.0" },
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

export async function checkForUpdates(): Promise<UpdateInfo[]> {
  const [installed, catalog] = await Promise.all([
    db.select().from(installedIntegration),
    getCatalog(),
  ]);

  const catalogMap = new Map(catalog.map((e) => [e.id, e]));
  return installed.map((inst) => {
    const entry = catalogMap.get(inst.id);
    return {
      id: inst.id,
      installedVersion: inst.installedVersion,
      latestVersion: entry?.version ?? inst.installedVersion,
      hasUpdate: !!entry && entry.version !== inst.installedVersion,
    };
  });
}

// Job: run integration.sh

function runIntegrationSh(args: string[], ctx: JobContext): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const proc = spawn("bash", [INTEGRATION_SH, ...args], {
      env: safeChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        ctx.log(line, "stdout").catch(() => {});
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        ctx.log(line, "stderr").catch(() => {});
      }
    });

    ctx.signal.addEventListener("abort", () => {
      proc.kill("SIGTERM");
    });

    proc.on("close", (code) => {
      if (ctx.signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`integration.sh exited with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

// Job handlers

export async function handleInstallJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { repository, version, actorId } = ctx.payload as {
    repository: string;
    version?: string;
    actorId?: string;
  };

  await ctx.log(`Installing integration from ${repository}${version ? ` @ ${version}` : ""}...`);
  await ctx.setProgress(5);

  // Build source arg: github:user/repo or URL
  let sourceArg = repository;
  if (repository.startsWith("https://github.com/")) {
    const path = repository.replace("https://github.com/", "");
    sourceArg = `github:${path.replace(/\.git$/, "")}`;
  }

  const args = ["install", sourceArg];
  if (version) {
    if (!/^[a-zA-Z0-9._\-/]+$/.test(version)) {
      throw new Error(`Invalid version format: "${version}"`);
    }
    args.push("--ref", version);
  }

  await ctx.setProgress(10);
  await runIntegrationSh(args, ctx);
  await ctx.setProgress(70);

  // Reload integrations to pick up the new one
  await ctx.log("Reloading integrations...");
  const reloadResult = await reloadIntegrations();
  await ctx.log(
    `Reload complete: ${reloadResult.reloaded} reloaded, ${reloadResult.enabled} enabled`,
  );
  await ctx.setProgress(90);

  // Derive the directory name (integration.sh names it after the repo)
  const repoName =
    repository
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") ?? "unknown";
  const dirName = repoName.replace(/^openmapx-/, "");

  // Read the actual manifest.json to get the canonical integration ID
  const manifestPath = join(ROOT_DIR, "custom_integrations", dirName, "manifest.json");
  let integrationId = dirName;
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string };
      if (manifest.id) integrationId = manifest.id;
    } catch {
      await ctx.log(
        `Warning: could not read manifest.json, using directory name as ID: ${dirName}`,
      );
    }
  }

  // Upsert installed_integration record
  const now = new Date();
  await db
    .insert(installedIntegration)
    .values({
      id: integrationId,
      repository,
      installedVersion: version ?? "latest",
      sourceType: "registry",
      installedAt: now,
      updatedAt: now,
      installedBy: (actorId as string) ?? null,
    })
    .onConflictDoUpdate({
      target: installedIntegration.id,
      set: {
        repository,
        installedVersion: version ?? "latest",
        updatedAt: now,
        installedBy: (actorId as string) ?? null,
      },
    });

  await ctx.setProgress(100);
  await ctx.log(`Integration ${integrationId} installed successfully.`);
  return { integrationId };
}

export async function handleUpdateJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { id, version, actorId } = ctx.payload as {
    id: string;
    version?: string;
    actorId?: string;
  };

  const [record] = await db
    .select()
    .from(installedIntegration)
    .where(eq(installedIntegration.id, id))
    .limit(1);

  if (!record) throw new Error(`Integration ${id} is not installed`);

  await ctx.log(`Updating integration ${id}${version ? ` to ${version}` : " to latest"}...`);
  await ctx.setProgress(5);

  let sourceArg = record.repository;
  if (record.repository.startsWith("https://github.com/")) {
    const path = record.repository.replace("https://github.com/", "");
    sourceArg = `github:${path.replace(/\.git$/, "")}`;
  }

  const args = ["install", sourceArg];
  if (version) {
    if (!/^[a-zA-Z0-9._\-/]+$/.test(version)) {
      throw new Error(`Invalid version format: "${version}"`);
    }
    args.push("--ref", version);
  }

  await ctx.setProgress(10);
  await runIntegrationSh(args, ctx);
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
      installedVersion: version ?? "latest",
      updatedAt: new Date(),
      installedBy: (actorId as string) ?? null,
    })
    .where(eq(installedIntegration.id, id));

  await ctx.setProgress(100);
  await ctx.log(`Integration ${id} updated successfully.`);
  return { integrationId: id, version: version ?? "latest" };
}

export async function handleRemoveJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { id } = ctx.payload as { id: string; actorId?: string };

  await ctx.log(`Removing integration ${id}...`);
  await ctx.setProgress(5);

  await runIntegrationSh(["remove", id], ctx);
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
