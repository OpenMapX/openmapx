import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertAllowedGitUrl, InvalidGitUrlError } from "@openmapx/core";
import { findRepoRoot, gitShallowCloneSnapshot, repoPaths, services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { type ServiceRepositoryRow, serviceRepository } from "../db/schema";

const { findServiceManifestDirs, getProvidedCapabilityNames, validateServiceManifest } = services;

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
 * The shared clone helper resolves the exact commit before stripping `.git`.
 * The result is a bounded snapshot matching the registry's expectations.
 */
async function cloneToTmp(url: string, ref?: string): Promise<ClonedRepo> {
  const tmp = join(communityDir(), `.tmp-clone-${randomBytes(6).toString("hex")}`);
  try {
    const clone = await gitShallowCloneSnapshot({ url, ref, targetDir: tmp });
    return { dir: clone.directory, sha: clone.commit };
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
  /** Journal a repository that has no prior DB row until extension commit. */
  journalNewInstall?: boolean;
  /** Service-selection roots to restore if that extension transaction never commits. */
  selectionBefore?: string[];
  /** Ensure replacement metadata is distinguishable from this prior fetch time. */
  minimumLastFetchedAtExclusive?: Date;
  touchedServiceIds?: string[];
  previouslyEnabledServiceIds?: string[];
}

/**
 * Opaque reference to a checkout which has been cloned and validated but not
 * yet made live. Its identifier never contains a filesystem path: publication
 * may only consume an entry retained by this module.
 */
export interface StagedServiceRepository {
  readonly id: string;
}

interface StagedRepositoryEntry {
  dir: string;
  prepared: Omit<PreparedServiceRepository, "preparationJournal">;
  journalNewInstall: boolean;
  selectionBefore?: string[];
  touchedServiceIds?: string[];
  previouslyEnabledServiceIds?: string[];
}

const stagedRepositories = new Map<string, StagedRepositoryEntry>();

function assertValidRepoPreviews(previews: RepoManifestPreview[]): void {
  const failed = previews.filter((p) => p.validationErrors.length > 0);
  if (failed.length > 0) {
    throw new InvalidGitUrlError(
      `Refusing to register: ${failed.length} service(s) failed validation: ` +
        failed.map((f) => `${f.slug}: ${f.validationErrors.join("; ")}`).join(" | "),
    );
  }
}

function stagedRepositoryEntry(stage: StagedServiceRepository): StagedRepositoryEntry {
  if (!stage || typeof stage.id !== "string" || !/^[a-f0-9]{24}$/.test(stage.id)) {
    throw new InvalidGitUrlError("Invalid staged repository");
  }
  const entry = stagedRepositories.get(stage.id);
  if (!entry) throw new InvalidGitUrlError("Unknown staged repository");
  return entry;
}

/** Clone and fully validate a repository while retaining the exact snapshot for publication. */
export async function stageRepo(
  url: string,
  opts: RegisterRepoOptions = {},
): Promise<StagedServiceRepository> {
  // Persist the canonical, credential-free form so the stored URL and its hash
  // are stable across equivalent spellings and can never carry a secret.
  const { canonical } = assertAllowedGitUrl(url);
  const { dir, sha } = await cloneToTmp(canonical, opts.ref);
  try {
    const previews = readPreviewsFromClone(dir);
    assertValidRepoPreviews(previews);
    const id = randomBytes(12).toString("hex");
    stagedRepositories.set(id, {
      dir,
      prepared: {
        hash: hashUrl(canonical),
        url: canonical,
        displayName: previews[0]?.name ?? null,
        lastFetchedAt: new Date(
          Math.max(Date.now(), (opts.minimumLastFetchedAtExclusive?.getTime() ?? -1) + 1),
        ),
        lastSha: sha,
        pinnedRef: opts.ref ?? null,
        managedByExtension: opts.managedByExtension ?? null,
      },
      journalNewInstall: opts.journalNewInstall === true,
      selectionBefore: opts.selectionBefore,
      touchedServiceIds: opts.touchedServiceIds,
      previouslyEnabledServiceIds: opts.previouslyEnabledServiceIds,
    });
    return { id };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Discard an unpublished staged checkout. Safe only for module-owned stage handles. */
export function discardStagedRepo(stage: StagedServiceRepository): void {
  const entry = stagedRepositoryEntry(stage);
  stagedRepositories.delete(stage.id);
  rmSync(entry.dir, { recursive: true, force: true });
}

/** Publish an exact staged checkout without fetching or cloning again. */
export function publishStagedRepo(stage: StagedServiceRepository): PreparedServiceRepository {
  const entry = stagedRepositoryEntry(stage);
  stagedRepositories.delete(stage.id);
  const target = join(communityDir(), entry.prepared.hash);
  let preparationJournal: string | undefined;
  try {
    preparationJournal = entry.journalNewInstall
      ? writePreparationJournal(entry.prepared, entry.selectionBefore, {
          touchedServiceIds: entry.touchedServiceIds,
          previouslyEnabledServiceIds: entry.previouslyEnabledServiceIds,
        })
      : undefined;
    moveIntoPlace(entry.dir, target);
  } catch (error) {
    rmSync(entry.dir, { recursive: true, force: true });
    if (preparationJournal) discardRepoPreparation(preparationJournal);
    throw error;
  }
  return { ...entry.prepared, ...(preparationJournal ? { preparationJournal } : {}) };
}

/** Clone and validate a service repository without changing its installed checkout. */
export async function preflightRepo(
  url: string,
  opts: Pick<RegisterRepoOptions, "ref"> = {},
): Promise<void> {
  const stage = await stageRepo(url, opts);
  discardStagedRepo(stage);
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

export interface PreparedServiceRepository {
  hash: string;
  url: string;
  displayName: string | null;
  lastFetchedAt: Date;
  lastSha: string;
  pinnedRef: string | null;
  managedByExtension: string | null;
  preparationJournal?: string;
}

const PREPARATION_JOURNAL_RE = /^\.prepare-([a-f0-9]{16})-[a-f0-9]{12}\.json$/;

function writePreparationJournal(
  row: Omit<PreparedServiceRepository, "preparationJournal">,
  selectionBefore: string[] | undefined,
  runtime: { touchedServiceIds?: string[]; previouslyEnabledServiceIds?: string[] } = {},
): string {
  const path = join(communityDir(), `.prepare-${row.hash}-${randomBytes(6).toString("hex")}.json`);
  const tmpPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(
      tmpPath,
      JSON.stringify({ version: 1, repository: row, selectionBefore, ...runtime }),
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    renameSync(tmpPath, path);
    return path;
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function discardRepoPreparation(journalPath: string): void {
  const root = resolve(communityDir());
  const path = resolve(journalPath);
  if (dirname(path) !== root || !PREPARATION_JOURNAL_RE.test(basename(path))) {
    throw new InvalidGitUrlError("Invalid repository preparation journal path");
  }
  rmSync(path, { force: true });
}

/** Prepare and publish a validated checkout without advancing database metadata. */
export async function prepareRepo(
  url: string,
  opts: RegisterRepoOptions = {},
): Promise<PreparedServiceRepository> {
  const stage = await stageRepo(url, opts);
  return publishStagedRepo(stage);
}

export async function registerRepo(
  url: string,
  opts: RegisterRepoOptions = {},
): Promise<ServiceRepositoryRow> {
  const prepared = await prepareRepo(url, opts);
  const { preparationJournal, ...row } = prepared;

  const rows = await db
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
    })
    .returning();
  if (!rows[0]) throw new Error("Failed to insert service repository");
  if (preparationJournal) discardRepoPreparation(preparationJournal);
  return rows[0];
}

export async function removeRepo(hash: string): Promise<void> {
  assertRepoHash(hash);
  const target = join(communityDir(), hash);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  await db.delete(serviceRepository).where(eq(serviceRepository.hash, hash));
}

export interface ServiceRepoRollbackBackup {
  snapshot: ServiceRepositoryRow;
  backupDir: string;
  selectionBefore?: string[];
  touchedServiceIds?: string[];
  previouslyEnabledServiceIds?: string[];
}

const ROLLBACK_BACKUP_RE = /^\.rollback-([a-f0-9]{16})-[a-f0-9]{12}$/;
const ROLLBACK_JOURNAL_RE = /^(\.rollback-([a-f0-9]{16})-[a-f0-9]{12})\.json$/;

type RollbackPhase = "prepared" | "restoring";

interface RollbackJournal {
  version: 1;
  phase: RollbackPhase;
  snapshot: ServiceRepositoryRow;
  selectionBefore?: string[];
  touchedServiceIds?: string[];
  previouslyEnabledServiceIds?: string[];
}

function rollbackJournalPath(backupDir: string): string {
  return `${backupDir}.json`;
}

function writeRollbackJournal(backup: ServiceRepoRollbackBackup, phase: RollbackPhase): void {
  const journalPath = rollbackJournalPath(validateRollbackBackup(backup));
  const tmpPath = `${journalPath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        version: 1,
        phase,
        snapshot: backup.snapshot,
        selectionBefore: backup.selectionBefore,
        touchedServiceIds: backup.touchedServiceIds,
        previouslyEnabledServiceIds: backup.previouslyEnabledServiceIds,
      } satisfies RollbackJournal),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    renameSync(tmpPath, journalPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new InvalidGitUrlError(`Invalid repository rollback journal ${field}`);
}

function nullableDate(value: unknown, field: string): Date | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new InvalidGitUrlError(`Invalid repository rollback journal ${field}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidGitUrlError(`Invalid repository rollback journal ${field}`);
  }
  return date;
}

interface PreparationJournal {
  repository: PreparedServiceRepository;
  selectionBefore?: string[];
  touchedServiceIds?: string[];
  previouslyEnabledServiceIds?: string[];
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new InvalidGitUrlError(`Invalid repository journal ${field}`);
  }
  return value;
}

function readPreparationJournal(journalPath: string): PreparationJournal {
  const root = resolve(communityDir());
  const path = resolve(journalPath);
  const match = PREPARATION_JOURNAL_RE.exec(basename(path));
  if (dirname(path) !== root || !match) {
    throw new InvalidGitUrlError("Invalid repository preparation journal path");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InvalidGitUrlError(
      `Invalid repository preparation journal: ${(error as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new InvalidGitUrlError("Invalid repository preparation journal");
  }
  const journal = raw as Record<string, unknown>;
  const stored = journal.repository;
  if (journal.version !== 1 || !stored || typeof stored !== "object") {
    throw new InvalidGitUrlError("Invalid repository preparation journal");
  }
  const row = stored as Record<string, unknown>;
  if (
    typeof row.hash !== "string" ||
    typeof row.url !== "string" ||
    typeof row.lastSha !== "string"
  ) {
    throw new InvalidGitUrlError("Invalid repository preparation journal row");
  }
  assertAllowedGitUrl(row.url);
  assertRepoHash(row.hash);
  if (row.hash !== match[1] || row.hash !== hashUrl(row.url)) {
    throw new InvalidGitUrlError("Repository preparation journal identity mismatch");
  }
  const lastFetchedAt = nullableDate(row.lastFetchedAt, "lastFetchedAt");
  if (!lastFetchedAt) {
    throw new InvalidGitUrlError("Invalid repository preparation journal lastFetchedAt");
  }
  if (
    journal.selectionBefore !== undefined &&
    (!Array.isArray(journal.selectionBefore) ||
      journal.selectionBefore.some((value) => typeof value !== "string"))
  ) {
    throw new InvalidGitUrlError("Invalid repository preparation journal selection");
  }
  return {
    repository: {
      hash: row.hash,
      url: row.url,
      displayName: nullableString(row.displayName, "displayName"),
      lastFetchedAt,
      lastSha: row.lastSha,
      pinnedRef: nullableString(row.pinnedRef, "pinnedRef"),
      managedByExtension: nullableString(row.managedByExtension, "managedByExtension"),
    },
    ...(journal.selectionBefore ? { selectionBefore: journal.selectionBefore as string[] } : {}),
    ...(stringArray(journal.touchedServiceIds, "touchedServiceIds")
      ? { touchedServiceIds: stringArray(journal.touchedServiceIds, "touchedServiceIds") }
      : {}),
    ...(stringArray(journal.previouslyEnabledServiceIds, "previouslyEnabledServiceIds")
      ? {
          previouslyEnabledServiceIds: stringArray(
            journal.previouslyEnabledServiceIds,
            "previouslyEnabledServiceIds",
          ),
        }
      : {}),
  };
}

function readRollbackJournal(journalPath: string): RollbackJournal & { backupDir: string } {
  const root = resolve(communityDir());
  const resolvedJournal = resolve(journalPath);
  const match = ROLLBACK_JOURNAL_RE.exec(basename(resolvedJournal));
  if (dirname(resolvedJournal) !== root || !match) {
    throw new InvalidGitUrlError("Invalid repository rollback journal path");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedJournal, "utf8"));
  } catch (error) {
    throw new InvalidGitUrlError(
      `Invalid repository rollback journal: ${(error as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new InvalidGitUrlError("Invalid repository rollback journal");
  }
  const journal = raw as Record<string, unknown>;
  if (journal.version !== 1 || (journal.phase !== "prepared" && journal.phase !== "restoring")) {
    throw new InvalidGitUrlError("Invalid repository rollback journal version or phase");
  }
  if (!journal.snapshot || typeof journal.snapshot !== "object") {
    throw new InvalidGitUrlError("Invalid repository rollback journal snapshot");
  }
  const stored = journal.snapshot as Record<string, unknown>;
  if (
    typeof stored.hash !== "string" ||
    typeof stored.url !== "string" ||
    typeof stored.autoUpdate !== "boolean"
  ) {
    throw new InvalidGitUrlError("Invalid repository rollback journal snapshot");
  }
  const createdAt = nullableDate(stored.createdAt, "createdAt");
  if (!createdAt) throw new InvalidGitUrlError("Invalid repository rollback journal createdAt");

  const backup: ServiceRepoRollbackBackup = {
    backupDir: join(root, match[1]),
    snapshot: {
      hash: stored.hash,
      url: stored.url,
      displayName: nullableString(stored.displayName, "displayName"),
      lastFetchedAt: nullableDate(stored.lastFetchedAt, "lastFetchedAt"),
      lastSha: nullableString(stored.lastSha, "lastSha"),
      autoUpdate: stored.autoUpdate,
      pinnedRef: nullableString(stored.pinnedRef, "pinnedRef"),
      managedByExtension: nullableString(stored.managedByExtension, "managedByExtension"),
      createdAt,
    },
  };
  if (
    journal.selectionBefore !== undefined &&
    (!Array.isArray(journal.selectionBefore) ||
      journal.selectionBefore.some((value) => typeof value !== "string"))
  ) {
    throw new InvalidGitUrlError("Invalid repository rollback journal selection");
  }
  if (journal.selectionBefore) {
    backup.selectionBefore = journal.selectionBefore as string[];
  }
  const touchedServiceIds = stringArray(journal.touchedServiceIds, "touchedServiceIds");
  const previouslyEnabledServiceIds = stringArray(
    journal.previouslyEnabledServiceIds,
    "previouslyEnabledServiceIds",
  );
  if (touchedServiceIds) backup.touchedServiceIds = touchedServiceIds;
  if (previouslyEnabledServiceIds) backup.previouslyEnabledServiceIds = previouslyEnabledServiceIds;
  validateRollbackBackup(backup);
  return {
    version: 1,
    phase: journal.phase,
    snapshot: backup.snapshot,
    backupDir: backup.backupDir,
    ...(backup.selectionBefore ? { selectionBefore: backup.selectionBefore } : {}),
    ...(backup.touchedServiceIds ? { touchedServiceIds: backup.touchedServiceIds } : {}),
    ...(backup.previouslyEnabledServiceIds
      ? { previouslyEnabledServiceIds: backup.previouslyEnabledServiceIds }
      : {}),
  };
}

function validateRollbackBackup(backup: ServiceRepoRollbackBackup): string {
  assertAllowedGitUrl(backup.snapshot.url);
  assertRepoHash(backup.snapshot.hash);
  if (backup.snapshot.hash !== hashUrl(backup.snapshot.url)) {
    throw new InvalidGitUrlError("Repository snapshot hash does not match its URL");
  }

  const root = resolve(communityDir());
  const backupDir = resolve(backup.backupDir);
  const match = ROLLBACK_BACKUP_RE.exec(basename(backupDir));
  if (dirname(backupDir) !== root || match?.[1] !== backup.snapshot.hash) {
    throw new InvalidGitUrlError("Invalid repository rollback backup path");
  }
  return backupDir;
}

/** Copy the installed snapshot aside without taking the live checkout offline. */
export function backupRepo(
  snapshot: ServiceRepositoryRow,
  opts: {
    selectionBefore?: string[];
    touchedServiceIds?: string[];
    previouslyEnabledServiceIds?: string[];
  } = {},
): ServiceRepoRollbackBackup {
  assertAllowedGitUrl(snapshot.url);
  assertRepoHash(snapshot.hash);
  if (snapshot.hash !== hashUrl(snapshot.url)) {
    throw new InvalidGitUrlError("Repository snapshot hash does not match its URL");
  }

  const target = join(communityDir(), snapshot.hash);
  if (!existsSync(target)) {
    throw new InvalidGitUrlError("Registered repository snapshot is missing from disk");
  }
  const backupDir = join(
    communityDir(),
    `.rollback-${snapshot.hash}-${randomBytes(6).toString("hex")}`,
  );
  const backup: ServiceRepoRollbackBackup = {
    snapshot,
    backupDir,
    ...(opts.selectionBefore ? { selectionBefore: opts.selectionBefore } : {}),
    ...(opts.touchedServiceIds ? { touchedServiceIds: opts.touchedServiceIds } : {}),
    ...(opts.previouslyEnabledServiceIds
      ? { previouslyEnabledServiceIds: opts.previouslyEnabledServiceIds }
      : {}),
  };
  try {
    cpSync(target, backupDir, { recursive: true, errorOnExist: true, force: false });
    writeRollbackJournal(backup, "prepared");
    return backup;
  } catch (error) {
    rmSync(rollbackJournalPath(backupDir), { force: true });
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}

/** Restore the exact local snapshot and database metadata after a failed update. */
export async function restoreRepo(backup: ServiceRepoRollbackBackup): Promise<void> {
  const backupDir = validateRollbackBackup(backup);
  if (!existsSync(backupDir)) {
    throw new InvalidGitUrlError("Repository rollback backup is missing from disk");
  }
  writeRollbackJournal(backup, "restoring");
  const { snapshot } = backup;
  const target = join(communityDir(), snapshot.hash);
  const restoreTmp = join(
    communityDir(),
    `.tmp-restore-${snapshot.hash}-${randomBytes(6).toString("hex")}`,
  );
  try {
    cpSync(backupDir, restoreTmp, { recursive: true, errorOnExist: true, force: false });
    moveIntoPlace(restoreTmp, target);
  } catch (error) {
    rmSync(restoreTmp, { recursive: true, force: true });
    throw error;
  }

  await db
    .update(serviceRepository)
    .set({
      displayName: snapshot.displayName,
      lastFetchedAt: snapshot.lastFetchedAt,
      lastSha: snapshot.lastSha,
      autoUpdate: snapshot.autoUpdate,
      pinnedRef: snapshot.pinnedRef,
      managedByExtension: snapshot.managedByExtension,
    })
    .where(eq(serviceRepository.hash, snapshot.hash));

  discardRepoBackup(backup);
}

/** Remove a rollback snapshot once the extension update is fully recorded. */
export function discardRepoBackup(backup: ServiceRepoRollbackBackup): void {
  const backupDir = validateRollbackBackup(backup);
  rmSync(rollbackJournalPath(backupDir), { force: true });
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
}

function dateValue(value: Date | null): number | null {
  return value?.getTime() ?? null;
}

function metadataMatches(current: ServiceRepositoryRow, snapshot: ServiceRepositoryRow): boolean {
  return (
    current.hash === snapshot.hash &&
    current.url === snapshot.url &&
    current.displayName === snapshot.displayName &&
    dateValue(current.lastFetchedAt) === dateValue(snapshot.lastFetchedAt) &&
    current.lastSha === snapshot.lastSha &&
    current.autoUpdate === snapshot.autoUpdate &&
    current.pinnedRef === snapshot.pinnedRef &&
    current.managedByExtension === snapshot.managedByExtension &&
    dateValue(current.createdAt) === dateValue(snapshot.createdAt)
  );
}

function preparedMetadataMatches(
  current: ServiceRepositoryRow,
  prepared: PreparedServiceRepository,
): boolean {
  return (
    current.hash === prepared.hash &&
    current.url === prepared.url &&
    current.displayName === prepared.displayName &&
    dateValue(current.lastFetchedAt) === prepared.lastFetchedAt.getTime() &&
    current.lastSha === prepared.lastSha &&
    current.pinnedRef === prepared.pinnedRef &&
    current.managedByExtension === prepared.managedByExtension
  );
}

/** Reconcile durable rollback journals before community services are discovered. */
export interface ServiceRuntimeRecovery {
  runtimeRecoveryNeeded: boolean;
  orphanedServiceIds: string[];
  restartServiceIds: string[];
  incidentId?: string;
}

export async function reconcileRepoBackups(
  opts: {
    restoreSelection?: (roots: string[], recoveryId: string) => Promise<void> | void;
    persistRuntimeRecovery?: (recovery: ServiceRuntimeRecovery) => Promise<void>;
  } = {},
): Promise<ServiceRuntimeRecovery> {
  const orphanedServiceIds = new Set<string>();
  const restartServiceIds = new Set<string>();
  const root = communityDir();
  if (!existsSync(root)) {
    return { runtimeRecoveryNeeded: false, orphanedServiceIds: [], restartServiceIds: [] };
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const journalNames = entries
    .filter((entry) => entry.isFile() && ROLLBACK_JOURNAL_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const preparationNames = entries
    .filter((entry) => entry.isFile() && PREPARATION_JOURNAL_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const recoveryIncidentParts = [
    ...journalNames.map(
      (name) =>
        `rollback:${name}:${createHash("sha256")
          .update(readFileSync(join(root, name)))
          .digest("hex")}`,
    ),
    ...preparationNames.map(
      (name) =>
        `prepare:${name}:${createHash("sha256")
          .update(readFileSync(join(root, name)))
          .digest("hex")}`,
    ),
  ];
  const incidentId = `recovery_${createHash("sha256")
    .update(recoveryIncidentParts.sort().join("\n"))
    .digest("hex")}`;
  const persistRuntimeRecovery = async (): Promise<void> => {
    if (orphanedServiceIds.size === 0 && restartServiceIds.size === 0) return;
    await opts.persistRuntimeRecovery?.({
      runtimeRecoveryNeeded: true,
      incidentId,
      orphanedServiceIds: [...orphanedServiceIds].sort(),
      restartServiceIds: [...restartServiceIds].sort(),
    });
  };
  const journalBackups = new Set(
    journalNames.map((name) => ROLLBACK_JOURNAL_RE.exec(name)?.[1]).filter(Boolean),
  );
  for (const entry of entries) {
    const match = entry.isDirectory() ? ROLLBACK_BACKUP_RE.exec(entry.name) : null;
    if (!match || journalBackups.has(entry.name)) continue;
    if (existsSync(join(root, match[1]))) {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }

  for (const journalName of journalNames) {
    const journalPath = join(root, journalName);
    try {
      await reconcileRollbackJournal(journalPath);
    } catch (error) {
      throw new Error(
        `Service repository rollback journal ${journalPath} could not be reconciled: ${(error as Error).message}. ` +
          "If the referenced backup was removed deliberately, delete this journal (and its .rollback-* directory) and restart.",
        { cause: error },
      );
    }
  }

  async function reconcileRollbackJournal(journalPath: string): Promise<void> {
    const journal = readRollbackJournal(journalPath);
    const backup: ServiceRepoRollbackBackup = {
      snapshot: journal.snapshot,
      backupDir: journal.backupDir,
      ...(journal.selectionBefore ? { selectionBefore: journal.selectionBefore } : {}),
      ...(journal.touchedServiceIds ? { touchedServiceIds: journal.touchedServiceIds } : {}),
      ...(journal.previouslyEnabledServiceIds
        ? { previouslyEnabledServiceIds: journal.previouslyEnabledServiceIds }
        : {}),
    };
    if (!existsSync(backup.backupDir)) {
      throw new Error(`Repository rollback backup is missing for ${journal.snapshot.url}`);
    }

    const [current] = await db
      .select()
      .from(serviceRepository)
      .where(eq(serviceRepository.hash, journal.snapshot.hash))
      .limit(1);
    if (!current) {
      throw new Error(`Repository metadata is missing for ${journal.snapshot.url}`);
    }

    if (journal.phase === "restoring" || metadataMatches(current, journal.snapshot)) {
      if (backup.selectionBefore) await opts.restoreSelection?.(backup.selectionBefore, incidentId);
      for (const id of backup.touchedServiceIds ?? []) orphanedServiceIds.add(id);
      for (const id of backup.previouslyEnabledServiceIds ?? []) restartServiceIds.add(id);
      await persistRuntimeRecovery();
      await restoreRepo(backup);
      return;
    }

    const target = join(root, journal.snapshot.hash);
    if (!existsSync(target)) {
      throw new Error(`Committed repository checkout is missing for ${journal.snapshot.url}`);
    }
    discardRepoBackup(backup);
  }

  for (const journalName of preparationNames) {
    const journalPath = join(root, journalName);
    try {
      await reconcilePreparationJournal(journalPath);
    } catch (error) {
      throw new Error(
        `Service repository preparation journal ${journalPath} could not be reconciled: ${(error as Error).message}. ` +
          "If the checkout was removed deliberately, delete this journal and restart.",
        { cause: error },
      );
    }
  }

  async function reconcilePreparationJournal(journalPath: string): Promise<void> {
    const preparation = readPreparationJournal(journalPath);
    const prepared = preparation.repository;
    const [current] = await db
      .select()
      .from(serviceRepository)
      .where(eq(serviceRepository.hash, prepared.hash))
      .limit(1);
    const target = join(root, prepared.hash);
    if (!current) {
      for (const id of preparation.touchedServiceIds ?? []) orphanedServiceIds.add(id);
      for (const id of preparation.previouslyEnabledServiceIds ?? []) restartServiceIds.add(id);
      await persistRuntimeRecovery();
      rmSync(target, { recursive: true, force: true });
      if (preparation.selectionBefore) {
        await opts.restoreSelection?.(preparation.selectionBefore, incidentId);
      }
      discardRepoPreparation(journalPath);
      return;
    }
    if (!preparedMetadataMatches(current, prepared)) {
      throw new Error(`Repository preparation metadata is ambiguous for ${prepared.url}`);
    }
    if (!existsSync(target)) {
      throw new Error(`Committed repository checkout is missing for ${prepared.url}`);
    }
    discardRepoPreparation(journalPath);
  }
  const runtimeRecoveryNeeded = orphanedServiceIds.size > 0 || restartServiceIds.size > 0;
  return {
    runtimeRecoveryNeeded,
    orphanedServiceIds: [...orphanedServiceIds].sort(),
    restartServiceIds: [...restartServiceIds].sort(),
    ...(runtimeRecoveryNeeded
      ? {
          incidentId,
        }
      : {}),
  };
}
