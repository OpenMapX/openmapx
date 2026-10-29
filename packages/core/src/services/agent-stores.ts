import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../release-files";
import { agentStatePaths } from "./agent-state";
import { CheckoutRequiredError, checkoutMountedAt } from "./checkout-layout";
import {
  type CommunityRepositoryRecord,
  communityRecordFileName,
  communityRecordRepository,
  type RecordedManifest,
  readCommunityRepositoryRecord,
  verifyRecordedRepository,
} from "./community-repository-records";
import {
  type IntegrationFileDigest,
  type IntegrationRecord,
  readIntegrationRecords,
  safeRelativePath,
} from "./integration-records";

/** Why an agent without the checkout refuses to prepare stores never copied from it. */
export const AGENT_STORES_NOT_COPIED =
  "The operations agent's community and integration stores were never copied from the checkout (infra/docker/state/ops-agent/stores-migration.json is missing), and this agent runs without the checkout: run `pnpm openmapx compose render` on the host, as the checkout's owner, which copies them.";

/**
 * The operations agent's two stores, the community service repositories and
 * the installed integrations, live in its state directory. Releases before
 * this one kept them in the checkout, as `services/.community` and
 * `custom_integrations`. They are copied once, not moved, so an earlier
 * release still finds them after a rollback.
 *
 * Trust in a copy comes from the agent's digest records, as it does for the
 * originals, never from file modes: every entry is checked against its
 * record and one that matches none of the states its record allows is left
 * behind and reported, as is anything without a record.
 */

export const AGENT_STORES_MIGRATION_VERSION = 1;
const REPOSITORY = /^[a-f0-9]{16}$/;
const INTEGRATION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface AgentStoreCopyReport {
  copied: string[];
  /** Entries with a record that could not be carried over, and why. */
  refused: Array<{ id: string; reason: string }>;
  /** Entries with no record, which are never copied. */
  unrecorded: string[];
}

export interface AgentStoresMigration {
  version: typeof AGENT_STORES_MIGRATION_VERSION;
  copiedAt: string;
  integrations: AgentStoreCopyReport;
  repositories: AgentStoreCopyReport;
}

/** Where releases before this one kept the stores, in the checkout. */
export function legacyAgentStorePaths(infraDir: string): {
  community: string;
  customIntegrations: string;
} {
  const rootDir = resolve(infraDir, "..", "..");
  return {
    community: join(rootDir, "services", ".community"),
    customIntegrations: join(rootDir, "custom_integrations"),
  };
}

function kind(path: string): "missing" | "directory" | "file" | "other" {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return "other";
    if (stats.isDirectory()) return "directory";
    return stats.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** The bytes of `relative` under `root`, reached through real directories only. */
function readRecordedFileBytes(root: string, relative: string): Buffer | null {
  if (!safeRelativePath(relative)) return null;
  const segments = relative.split("/");
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    if (kind(directory) !== "directory") return null;
  }
  let fd: number;
  try {
    fd = openSync(
      join(directory, segments.at(-1) as string),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies exactly the files `candidates` lists from `source` to `target`, for
 * the first candidate every file of which is present with its recorded digest.
 * Returns whether one matched; on no match nothing is left at `target`.
 */
function copyRecordedFiles(
  source: string,
  target: string,
  candidates: ReadonlyArray<readonly IntegrationFileDigest[]>,
): boolean {
  for (const files of candidates) {
    const contents: Array<[string, Buffer]> = [];
    for (const { path, sha256 } of files) {
      const bytes = readRecordedFileBytes(source, path);
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== sha256) break;
      contents.push([path, bytes]);
    }
    if (contents.length !== files.length || files.length === 0) continue;
    for (const [path, bytes] of contents) {
      const destination = join(target, ...path.split("/"));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      writeFileSync(destination, bytes, { mode: 0o644, flag: "wx" });
    }
    return true;
  }
  return false;
}

function installedFiles(installation: {
  status: string;
  files: readonly IntegrationFileDigest[];
}): IntegrationFileDigest[] | null {
  return installation.status === "ok" && installation.files.length > 0
    ? [...installation.files]
    : null;
}

function copyIntegrations(legacy: string, staging: string, infraDir: string, uid: number) {
  const report: AgentStoreCopyReport = { copied: [], refused: [], unrecorded: [] };
  const { records, unreadable } = readIntegrationRecords(infraDir, uid);
  for (const id of unreadable) {
    report.refused.push({ id, reason: "its install record could not be read" });
  }
  const copyOne = (integrationId: string, record: IntegrationRecord): string | null => {
    const source = join(legacy, integrationId);
    const target = join(staging, integrationId);
    const pending = record.pending;
    // Any state recovery may find: the installed files, and during a
    // transaction the ones it installs or the ones it replaced.
    const states = [
      installedFiles(record),
      pending ? installedFiles(pending.next) : null,
      pending?.previous ? installedFiles(pending.previous) : null,
    ].filter((files): files is IntegrationFileDigest[] => files !== null);
    const present = kind(source);
    if (present === "missing") {
      if (pending || states.length === 0) return null;
      return "its files are missing";
    }
    if (present !== "directory") return "it is not a directory";
    if (states.length === 0) return null;
    if (!copyRecordedFiles(source, target, states)) {
      return "its files no longer match the agent's install record";
    }
    if (pending) {
      const backupName = `.agent-backup-${integrationId}-${pending.transactionId}`;
      const backup = join(legacy, backupName);
      if (kind(backup) !== "missing") {
        const previous = pending.previous ? installedFiles(pending.previous) : null;
        if (
          kind(backup) !== "directory" ||
          !previous ||
          !copyRecordedFiles(backup, join(staging, backupName), [previous])
        ) {
          rmSync(target, { recursive: true, force: true });
          return "the copy it replaced, kept for an unfinished change, no longer matches its record";
        }
      }
    }
    return null;
  };
  for (const [integrationId, record] of records) {
    const refused = copyOne(integrationId, record);
    if (refused) report.refused.push({ id: integrationId, reason: refused });
    else if (kind(join(staging, integrationId)) === "directory") report.copied.push(integrationId);
  }
  if (kind(legacy) === "directory") {
    for (const name of readdirSync(legacy).sort()) {
      if (!INTEGRATION_ID.test(name) || records.has(name) || unreadable.includes(name)) continue;
      if (kind(join(legacy, name)) === "directory") report.unrecorded.push(name);
    }
  }
  return report;
}

function copyRepositories(legacy: string, staging: string, uid: number) {
  const report: AgentStoreCopyReport = { copied: [], refused: [], unrecorded: [] };
  if (kind(legacy) !== "directory") return report;
  const names = readdirSync(legacy).sort();
  const recorded = new Set<string>();
  for (const name of names) {
    const repository = communityRecordRepository(name);
    if (!repository) continue;
    recorded.add(repository);
    let record: CommunityRepositoryRecord | null;
    try {
      record = readCommunityRepositoryRecord(legacy, repository, uid);
    } catch {
      report.refused.push({ id: repository, reason: "its record is not one the agent wrote" });
      continue;
    }
    if (!record) continue;
    const refused = copyRepository(legacy, staging, record);
    if (refused) report.refused.push({ id: repository, reason: refused });
    else report.copied.push(repository);
  }
  for (const name of names) {
    if (REPOSITORY.test(name) && !recorded.has(name) && kind(join(legacy, name)) === "directory") {
      report.unrecorded.push(name);
    }
  }
  return report;
}

function copyRepository(
  legacy: string,
  staging: string,
  record: CommunityRepositoryRecord,
): string | null {
  const { repository } = record;
  const copied: string[] = [];
  // Only what the record trusts is carried over: the recorded service
  // manifests of one of the states it allows, each read without following a
  // link and matching its recorded digest. Nothing else in a checkout is
  // read, by the agent or by anyone it serves.
  const copyManifests = (
    name: string,
    candidates: ReadonlyArray<readonly RecordedManifest[] | null | undefined>,
  ): boolean => {
    const files = candidates
      .filter((manifests): manifests is readonly RecordedManifest[] => !!manifests)
      .map((manifests) =>
        manifests.map(({ path, sha256 }) => ({
          path: path === "" ? "service.json" : `${path}/service.json`,
          sha256,
        })),
      );
    if (!copyRecordedFiles(join(legacy, name), join(staging, name), files)) return false;
    copied.push(name);
    return true;
  };
  const undo = (reason: string) => {
    for (const name of copied) rmSync(join(staging, name), { recursive: true, force: true });
    return reason;
  };
  const present = kind(join(legacy, repository));
  if (present !== "missing" && present !== "directory") return "its checkout is not a directory";
  const pending = record.pending;
  if (present === "missing") {
    // Only a change in progress may leave a repository without its checkout.
    if (!pending && record.manifests) return "its checkout is missing";
  } else if (!copyManifests(repository, [record.manifests, pending?.next.manifests])) {
    return "its checkout no longer matches the service manifests the agent recorded";
  }
  try {
    // The copy, not the original: what was checked is what is carried over.
    verifyRecordedRepository(join(staging, repository), record);
  } catch {
    return undo("its checkout no longer matches the service manifests the agent recorded");
  }
  if (pending) {
    const backupName = `.backup-${repository}-${pending.transactionId}`;
    if (kind(join(legacy, backupName)) !== "missing") {
      const previous = pending.previous?.manifests;
      if (!previous || !copyManifests(backupName, [previous])) {
        return undo(
          "the checkout it replaced, kept for an unfinished change, is not one it recorded",
        );
      }
    }
  }
  // The record the agent validated, as the agent writes its records; the
  // file is not read a second time.
  writeFileSync(
    join(staging, communityRecordFileName(repository)),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return null;
}

/** The record of the one-time copy, or `null` before it has run. */
export function readAgentStoresMigration(infraDir: string): AgentStoresMigration | null {
  const path = agentStatePaths(infraDir).storesMigration;
  if (kind(path) === "missing") return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentStoresMigration;
    if (parsed?.version !== AGENT_STORES_MIGRATION_VERSION) throw new Error();
    return parsed;
  } catch {
    throw new Error(`The record of the agent's store copy at ${path} can't be read`);
  }
}

/** A directory of this user's own, kept owner-only; anything else there is refused. */
function ensureStoreDirectory(path: string, uid: number): void {
  if (kind(path) === "missing") mkdirSync(path, { mode: 0o700 });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== uid) {
    throw new Error(`The agent's store at ${path} is not its own directory`);
  }
  chmodSync(path, 0o700);
}

/**
 * Makes sure both stores exist in the agent's state directory, owner-only,
 * before a configuration generation mounts one of them. The first time, it
 * copies what the checkout held, verified against the agent's records, and
 * returns what it copied, refused and found without a record; later calls
 * return `null`. Run under the configuration writer lock. The agent runs it
 * after it has undone unfinished changes in the old locations. An agent
 * without the checkout can't make that first copy, and refuses rather than
 * record that there was nothing to copy.
 */
export function prepareAgentStores(
  infraDir: string,
  options: { uid?: number; now?: () => Date } = {},
): AgentStoresMigration | null {
  const uid = options.uid ?? process.geteuid?.() ?? 0;
  const paths = agentStatePaths(infraDir);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  if (kind(paths.storesMigration) !== "missing") {
    ensureStoreDirectory(paths.community, uid);
    ensureStoreDirectory(paths.customIntegrations, uid);
    return null;
  }
  if (!checkoutMountedAt(infraDir)) throw new CheckoutRequiredError(AGENT_STORES_NOT_COPIED);
  const legacy = legacyAgentStorePaths(infraDir);
  const staging = join(paths.directory, `.stores-copy-${randomBytes(6).toString("hex")}`);
  mkdirSync(join(staging, "community"), { recursive: true, mode: 0o700 });
  mkdirSync(join(staging, "custom-integrations"), { recursive: true, mode: 0o700 });
  // A store that already holds something was copied before this record was
  // written, as when a copy stopped between the two: it is kept as it is.
  const populated = (target: string) =>
    kind(target) === "directory" && readdirSync(target).length > 0;
  const nothing: AgentStoreCopyReport = { copied: [], refused: [], unrecorded: [] };
  try {
    const migration: AgentStoresMigration = {
      version: AGENT_STORES_MIGRATION_VERSION,
      copiedAt: (options.now?.() ?? new Date()).toISOString(),
      integrations: populated(paths.customIntegrations)
        ? nothing
        : copyIntegrations(
            legacy.customIntegrations,
            join(staging, "custom-integrations"),
            infraDir,
            uid,
          ),
      repositories: populated(paths.community)
        ? nothing
        : copyRepositories(legacy.community, join(staging, "community"), uid),
    };
    for (const [name, target] of [
      ["community", paths.community],
      ["custom-integrations", paths.customIntegrations],
    ] as const) {
      if (populated(target)) {
        ensureStoreDirectory(target, uid);
        continue;
      }
      if (kind(target) === "directory") rmdirSync(target);
      renameSync(join(staging, name), target);
      chmodSync(target, 0o700);
    }
    atomicWrite(paths.storesMigration, `${JSON.stringify(migration, null, 2)}\n`, 0o600);
    return migration;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** What a copy just did, for the render's output and the agent's log. */
export function describeAgentStoresMigration(
  migration: AgentStoresMigration | null,
  infraDir: string,
): Array<{ level: "info" | "warn"; message: string }> {
  if (!migration) return [];
  const { integrations, repositories } = migration;
  const lines: Array<{ level: "info" | "warn"; message: string }> = [];
  if (integrations.copied.length + repositories.copied.length > 0) {
    lines.push({
      level: "info",
      message: `Copied ${integrations.copied.length} installed integration${integrations.copied.length === 1 ? "" : "s"} and ${repositories.copied.length} community repositor${repositories.copied.length === 1 ? "y" : "ies"} into infra/docker/state/ops-agent, each verified against the agent's records; the earlier copies in the checkout stay for rolling back and are no longer read.`,
    });
  }
  for (const message of agentStoresLeftBehind(infraDir)) lines.push({ level: "warn", message });
  return lines;
}

/**
 * What the copy left behind that is still there, one line each, for `check`
 * and the agent's log: a refused or unrecorded entry whose original remains
 * in the checkout and that the new store does not hold.
 */
export function agentStoresLeftBehind(infraDir: string): string[] {
  const migration = readAgentStoresMigration(infraDir);
  if (!migration) return [];
  const paths = agentStatePaths(infraDir);
  const legacy = legacyAgentStorePaths(infraDir);
  const lines: string[] = [];
  const describe = (
    report: AgentStoreCopyReport,
    from: string,
    to: string,
    noun: string,
    shown: string,
  ) => {
    for (const { id, reason } of report.refused) {
      if (kind(join(from, id)) === "missing" || kind(join(to, id)) !== "missing") continue;
      lines.push(
        `The ${noun} ${id} in ${shown} was not copied into the operations agent's state: ${reason}. Install it again through the admin panel, then delete ${shown}/${id}.`,
      );
    }
    for (const id of report.unrecorded) {
      if (kind(join(from, id)) === "missing" || kind(join(to, id)) !== "missing") continue;
      lines.push(
        `The ${noun} ${id} in ${shown} was not copied into the operations agent's state: the agent holds no record of it. Install it through the admin panel if you need it, then delete ${shown}/${id}.`,
      );
    }
  };
  describe(
    migration.integrations,
    legacy.customIntegrations,
    paths.customIntegrations,
    "integration",
    "custom_integrations",
  );
  describe(
    migration.repositories,
    legacy.community,
    paths.community,
    "community repository",
    "services/.community",
  );
  return lines;
}
