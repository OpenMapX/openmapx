import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { services } from "@openmapx/core";
import { eq } from "drizzle-orm";
import simpleGit, { type SimpleGit } from "simple-git";
import { db } from "../db";
import { type ServiceRepositoryRow, serviceRepository } from "../db/schema";

const { validateServiceManifest } = services;

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function repoRoot(): string {
  // apps/api is two levels down from repo root
  return resolve(process.cwd(), "..", "..");
}

function communityDir(): string {
  return join(repoRoot(), "services", ".community");
}

export interface RepoManifestPreview {
  slug: string;
  name: string;
  version: string;
  description?: string;
  quality: string;
  provides: string[];
  needsCapabilities: string[];
  hostPorts: number[];
  proxyEnabled: boolean;
  devices: string[];
  validationErrors: string[];
}

export async function previewRepo(url: string): Promise<{
  hash: string;
  services: RepoManifestPreview[];
}> {
  const hash = hashUrl(url);
  const target = join(communityDir(), hash);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }

  const git: SimpleGit = simpleGit();
  await git.clone(url, target, ["--depth", "1"]);

  const servicesList: RepoManifestPreview[] = [];
  const entries = readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(target, entry.name, "service.json");
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      servicesList.push(buildErrorPreview(entry.name, [`Invalid JSON: ${(err as Error).message}`]));
      continue;
    }

    const validation = validateServiceManifest(raw);
    if (!validation.valid) {
      servicesList.push(buildErrorPreview(entry.name, validation.errors));
      continue;
    }

    const m = raw as Record<string, unknown>;
    const c = (m.container ?? {}) as Record<string, unknown>;
    const exposure = (m.exposure ?? {}) as Record<string, unknown>;
    const hostPorts = ((exposure.hostPorts ?? []) as Array<{ host: number }>).map((p) => p.host);
    const proxyEnabled = Boolean((exposure.proxy as Record<string, unknown> | undefined)?.enabled);

    servicesList.push({
      slug: m.id as string,
      name: m.name as string,
      version: m.version as string,
      description: m.description as string | undefined,
      quality: m.quality as string,
      provides: (m.provides ?? []) as string[],
      needsCapabilities: (c.capAdd ?? []) as string[],
      hostPorts,
      proxyEnabled,
      devices: (c.devices ?? []) as string[],
      validationErrors: [],
    });
  }

  return { hash, services: servicesList };
}

function buildErrorPreview(slug: string, errors: string[]): RepoManifestPreview {
  return {
    slug,
    name: slug,
    version: "?",
    quality: "community",
    provides: [],
    needsCapabilities: [],
    hostPorts: [],
    proxyEnabled: false,
    devices: [],
    validationErrors: errors,
  };
}

export async function registerRepo(url: string): Promise<ServiceRepositoryRow> {
  const hash = hashUrl(url);
  const target = join(communityDir(), hash);
  if (!existsSync(target)) {
    await simpleGit().clone(url, target, ["--depth", "1"]);
  }

  const git = simpleGit(target);
  const sha = (await git.revparse(["HEAD"])).trim();

  const rows = await db
    .insert(serviceRepository)
    .values({ hash, url, lastFetchedAt: new Date(), lastSha: sha })
    .onConflictDoUpdate({
      target: serviceRepository.hash,
      set: { lastFetchedAt: new Date(), lastSha: sha },
    })
    .returning();
  if (!rows[0]) throw new Error("Failed to insert service repository");
  return rows[0];
}

export async function listRepos(): Promise<ServiceRepositoryRow[]> {
  return db.select().from(serviceRepository);
}

export async function removeRepo(hash: string): Promise<void> {
  const target = join(communityDir(), hash);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  await db.delete(serviceRepository).where(eq(serviceRepository.hash, hash));
}

export async function refreshRepo(hash: string): Promise<ServiceRepositoryRow | null> {
  const [row] = await db
    .select()
    .from(serviceRepository)
    .where(eq(serviceRepository.hash, hash))
    .limit(1);
  if (!row) return null;

  const target = join(communityDir(), hash);
  const git = simpleGit(target);
  await git.fetch();
  await git.reset(["--hard", "origin/HEAD"]);
  const sha = (await git.revparse(["HEAD"])).trim();

  const [updated] = await db
    .update(serviceRepository)
    .set({ lastFetchedAt: new Date(), lastSha: sha })
    .where(eq(serviceRepository.hash, hash))
    .returning();
  return updated ?? null;
}
