import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertAllowedGitUrl, InvalidGitUrlError } from "@openmapx/core";
import { findRepoRoot, gitShallowCloneAtomic, repoPaths, services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { db } from "../db";
import { type ServiceRepositoryRow, serviceRepository } from "../db/schema";

const { getProvidedCapabilityNames, validateServiceManifest } = services;

// Re-export under the historical name + class so existing callers (and tests)
// keep working. The implementation lives in @openmapx/core and is shared with
// the community-integration installer.
export { InvalidGitUrlError as InvalidRepoUrlError };
export const assertAllowedUrl = assertAllowedGitUrl;

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

const REPO_HASH_RE = /^[a-f0-9]{16}$/;

function assertRepoHash(hash: string): void {
  if (typeof hash !== "string" || !REPO_HASH_RE.test(hash)) {
    throw new InvalidGitUrlError("Invalid repository hash");
  }
}

function communityDir(): string {
  return repoPaths(findRepoRoot()).communityDir;
}

export interface RepoHostPort {
  host: number;
  container: number;
  protocol?: "tcp" | "udp";
  /** Loopback (127.0.0.1, ::1) is much lower-risk than the absent default of all interfaces. */
  bindAddress?: string;
}

export interface RepoManifestPreview {
  slug: string;
  name: string;
  version: string;
  description?: string;
  quality: string;
  provides: string[];
  needsCapabilities: string[];
  hostPorts: RepoHostPort[];
  proxyEnabled: boolean;
  devices: string[];
  validationErrors: string[];
}

export interface RepoPreview {
  hash: string;
  /** First service's `name` if any, used as the human-readable label for the repo row. */
  suggestedDisplayName?: string;
  services: RepoManifestPreview[];
}

/**
 * Clone-then-rename atomically into `services/.community/<hash>/`. Two admins
 * concurrently submitting the same URL each clone into a unique tmp dir and
 * the second `renameSync` over `<hash>` simply replaces the first — no torn
 * state, no half-finished clones for downstream readers. Implementation is
 * shared with the community-integration installer via `@openmapx/core`.
 */
async function atomicShallowClone(url: string, finalTarget: string): Promise<void> {
  await gitShallowCloneAtomic({ url, finalTarget });
}

function readPreviewsFromClone(target: string): RepoManifestPreview[] {
  const out: RepoManifestPreview[] = [];
  const entries = readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(target, entry.name, "service.json");
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      out.push(buildErrorPreview(entry.name, [`Invalid JSON: ${(err as Error).message}`]));
      continue;
    }

    const validation = validateServiceManifest(raw);
    if (!validation.valid) {
      out.push(buildErrorPreview(entry.name, validation.errors));
      continue;
    }

    const m = raw as Record<string, unknown>;
    const c = (m.container ?? {}) as Record<string, unknown>;
    const exposure = (m.exposure ?? {}) as Record<string, unknown>;
    const hostPorts = ((exposure.hostPorts ?? []) as RepoHostPort[]).map((p) => ({
      host: p.host,
      container: p.container,
      protocol: p.protocol,
      bindAddress: p.bindAddress,
    }));
    const proxyEnabled = Boolean((exposure.proxy as Record<string, unknown> | undefined)?.enabled);

    out.push({
      slug: m.id as string,
      name: m.name as string,
      version: m.version as string,
      description: m.description as string | undefined,
      quality: m.quality as string,
      // Normalise the union shape (string | { capability, metadata? }) to
      // bare strings for the install-preview UI.
      provides: getProvidedCapabilityNames(
        m.provides as Parameters<typeof getProvidedCapabilityNames>[0],
      ),
      needsCapabilities: (c.capAdd ?? []) as string[],
      hostPorts,
      proxyEnabled,
      devices: (c.devices ?? []) as string[],
      validationErrors: [],
    });
  }
  return out;
}

export async function previewRepo(url: string): Promise<RepoPreview> {
  assertAllowedUrl(url);
  const hash = hashUrl(url);
  const target = join(communityDir(), hash);
  await atomicShallowClone(url, target);
  const list = readPreviewsFromClone(target);
  const suggestedDisplayName = list.find((s) => s.validationErrors.length === 0)?.name;
  return { hash, suggestedDisplayName, services: list };
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
  assertAllowedUrl(url);
  const hash = hashUrl(url);
  const target = join(communityDir(), hash);
  if (!existsSync(target)) {
    await atomicShallowClone(url, target);
  }

  // Re-validate every manifest at registration time. A repo that previewed
  // cleanly could have been edited between preview and confirmation; refusing
  // here prevents an admin-visible row pointing at a registry-rejected service.
  const previews = readPreviewsFromClone(target);
  const failed = previews.filter((p) => p.validationErrors.length > 0);
  if (failed.length > 0) {
    rmSync(target, { recursive: true, force: true });
    throw new InvalidGitUrlError(
      `Refusing to register: ${failed.length} service(s) failed validation: ` +
        failed.map((f) => `${f.slug}: ${f.validationErrors.join("; ")}`).join(" | "),
    );
  }

  const git = simpleGit(target);
  const sha = (await git.revparse(["HEAD"])).trim();
  const displayName = previews[0]?.name ?? null;

  const rows = await db
    .insert(serviceRepository)
    .values({ hash, url, displayName, lastFetchedAt: new Date(), lastSha: sha })
    .onConflictDoUpdate({
      target: serviceRepository.hash,
      set: { displayName, lastFetchedAt: new Date(), lastSha: sha },
    })
    .returning();
  if (!rows[0]) throw new Error("Failed to insert service repository");
  return rows[0];
}

export async function listRepos(): Promise<ServiceRepositoryRow[]> {
  return db.select().from(serviceRepository);
}

export async function removeRepo(hash: string): Promise<void> {
  assertRepoHash(hash);
  const target = join(communityDir(), hash);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  await db.delete(serviceRepository).where(eq(serviceRepository.hash, hash));
}

export async function refreshRepo(hash: string): Promise<ServiceRepositoryRow | null> {
  assertRepoHash(hash);
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
