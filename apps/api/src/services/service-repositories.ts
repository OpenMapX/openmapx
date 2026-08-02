import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { assertAllowedGitUrl, InvalidGitUrlError } from "@openmapx/core";
import { findRepoRoot, gitShallowClone, repoPaths, services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { db } from "../db";
import { type ServiceRepositoryRow, serviceRepository } from "../db/schema";

const { findServiceManifestDirs, getProvidedCapabilityNames, validateServiceManifest } = services;

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

interface ClonedRepo {
  /** Tmp directory holding the snapshot (no `.git`). Caller owns it: rename it
   * into place on success, or `rmSync` it on validation failure. */
  dir: string;
  /** The resolved commit SHA the clone is pinned to. */
  sha: string;
}

/**
 * Clone `url` (optionally at `ref`) into a fresh tmp directory *inside* the
 * community dir (so the later `renameSync` into `<hash>` stays on the same
 * filesystem) and resolve its commit SHA.
 *
 * We keep `.git` during the clone purely to run `git rev-parse HEAD`, then strip
 * it before returning — a stripped clone placed inside the monorepo working tree
 * would otherwise resolve `rev-parse`/`fetch`/`reset` against the *monorepo*,
 * not the clone (a real, previously-latent bug in the fetch+reset refresh path).
 * The result is a snapshot with no `.git`, matching the registry's expectations.
 */
async function cloneToTmp(url: string, ref?: string): Promise<ClonedRepo> {
  const tmp = join(communityDir(), `.tmp-clone-${randomBytes(6).toString("hex")}`);
  try {
    await gitShallowClone({ url, ref, targetDir: tmp, keepGit: true });
    const sha = (await simpleGit(tmp).revparse(["HEAD"])).trim();
    rmSync(join(tmp, ".git"), { recursive: true, force: true });
    return { dir: tmp, sha };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Atomically replace `<hash>` with a freshly-cloned snapshot. */
function moveIntoPlace(tmpDir: string, finalTarget: string): void {
  if (existsSync(finalTarget)) rmSync(finalTarget, { recursive: true, force: true });
  renameSync(tmpDir, finalTarget);
}

function readPreviewsFromClone(target: string): RepoManifestPreview[] {
  const out: RepoManifestPreview[] = [];
  // Discover manifests anywhere in the clone (bounded), so a repo can ship its
  // service.json next to the service (e.g. services/ingest/service.json), not
  // only at the repo root. Same finder the runtime registry uses, so preview
  // and load always agree.
  for (const svcDir of findServiceManifestDirs(target)) {
    const manifestPath = join(svcDir, "service.json");
    const slug = basename(svcDir);

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      out.push(buildErrorPreview(slug, [`Invalid JSON: ${(err as Error).message}`]));
      continue;
    }

    // Everything this function sees is a cloned third-party repo destined for
    // services/.community/, so it never carries first-party provenance.
    const validation = validateServiceManifest(raw, { firstParty: false });
    if (!validation.valid) {
      out.push(buildErrorPreview(slug, validation.errors));
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

export interface RegisterRepoOptions {
  /** Pinned git tag/branch to clone (defaults to the repo's default branch). */
  ref?: string;
  /** Extension id that owns this repo (set by the extension installer). */
  managedByExtension?: string;
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

export async function registerRepo(
  url: string,
  opts: RegisterRepoOptions = {},
): Promise<ServiceRepositoryRow> {
  assertAllowedUrl(url);
  const hash = hashUrl(url);
  const target = join(communityDir(), hash);

  // Clone fresh into a tmp dir so validation runs against the new content and
  // an existing registered clone is only replaced once validation passes.
  const { dir, sha } = await cloneToTmp(url, opts.ref);

  const previews = readPreviewsFromClone(dir);
  const failed = previews.filter((p) => p.validationErrors.length > 0);
  if (failed.length > 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new InvalidGitUrlError(
      `Refusing to register: ${failed.length} service(s) failed validation: ` +
        failed.map((f) => `${f.slug}: ${f.validationErrors.join("; ")}`).join(" | "),
    );
  }

  moveIntoPlace(dir, target);
  const displayName = previews[0]?.name ?? null;
  const pinnedRef = opts.ref ?? null;
  const managedByExtension = opts.managedByExtension ?? null;

  const rows = await db
    .insert(serviceRepository)
    .values({
      hash,
      url,
      displayName,
      lastFetchedAt: new Date(),
      lastSha: sha,
      pinnedRef,
      managedByExtension,
    })
    .onConflictDoUpdate({
      target: serviceRepository.hash,
      set: { displayName, lastFetchedAt: new Date(), lastSha: sha, pinnedRef, managedByExtension },
    })
    .returning();
  if (!rows[0]) throw new Error("Failed to insert service repository");
  return rows[0];
}

export async function removeRepo(hash: string): Promise<void> {
  assertRepoHash(hash);
  const target = join(communityDir(), hash);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  await db.delete(serviceRepository).where(eq(serviceRepository.hash, hash));
}
