import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { OpsJobState, OpsOperation } from "@openmapx/core/ops";
import {
  acquireTrustedConfigurationQueueLock,
  inspectTrustedConfigurationSnapshot,
  OPS_TRUSTED_CONFIG_MAX_BYTES,
  OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME,
  openTrustedConfigurationSnapshot,
  trustedConfigurationQueueFits,
} from "@openmapx/core/ops";
import type { OpsClaimOwner, TrustedOpsDataSource } from "./policy";
import type { OpsTrustedClaim } from "./runtime";

const DIRECTORY_MODE = 0o700;
const SNAPSHOT_MODE = 0o600;
const DIRECTORY_REJECTED = "Trusted configuration snapshot directory rejected";
const MAX_SCAN_ENTRIES = 1_024;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const SNAPSHOT_NAME = /^cfg1_[A-Za-z0-9_-]{43}\.json$/;
const TEMPORARY_NAME = /^\.cfg1_[A-Za-z0-9_-]{43}\.nonce_[A-Za-z0-9_-]{16,96}\.tmp$/;
const ABORT_NAME = /^\.cfg1_[A-Za-z0-9_-]{43}\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.abort$/;
const HARDLINK_ABORT_NAME = /^\.(cfg1_[A-Za-z0-9_-]{43})\.(terminal|rollback)\.abort$/;

export interface TrustedSnapshotDirectoryPolicy {
  allowedUids: readonly number[];
  expectedGid: number;
  token: string;
  nowMs?: number;
  journalRecords?: readonly {
    operation: OpsOperation;
    state: OpsJobState;
    terminalAt?: string;
  }[];
  /** Deterministic filesystem-race seam used only by focused tests. */
  beforeCleanupUnlink?: (path: string) => void;
}

interface QueueFileIdentity {
  size: number;
  bytes: Buffer;
  dev: number;
  ino: number;
  nlink: number;
  uid: number;
  gid: number;
  mode: number;
}

interface QueueDirectoryIdentity {
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
}

interface QueueCleanupEntry {
  path: string;
  parent: string;
  parentIdentity: QueueDirectoryIdentity;
  identity: QueueFileIdentity;
}

interface QueueCleanupPlan {
  first: QueueCleanupEntry;
  second?: QueueCleanupEntry;
}

function journalRevisionIds(policy: TrustedSnapshotDirectoryPolicy): {
  all: ReadonlySet<string>;
  terminal: ReadonlySet<string>;
} {
  const records = policy.journalRecords ?? [];
  if (records.length > 256) throw new Error(DIRECTORY_REJECTED);
  const terminal = new Set<string>();
  const all = new Set<string>();
  for (const record of records) {
    const isTerminal = ["succeeded", "failed", "timed_out"].includes(record.state);
    if (isTerminal !== (record.terminalAt !== undefined)) throw new Error(DIRECTORY_REJECTED);
    if (!("revisionId" in record.operation)) continue;
    if (!/^cfg1_[A-Za-z0-9_-]{43}$/.test(record.operation.revisionId)) {
      throw new Error(DIRECTORY_REJECTED);
    }
    all.add(record.operation.revisionId);
    if (isTerminal) terminal.add(record.operation.revisionId);
  }
  return { all, terminal };
}

function directoryIsSafe(path: string, policy: TrustedSnapshotDirectoryPolicy): boolean {
  const stats = lstatSync(path);
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    policy.allowedUids.includes(stats.uid) &&
    stats.gid === policy.expectedGid &&
    (stats.mode & 0o777) === (DIRECTORY_MODE & 0o777)
  );
}

function captureQueueDirectory(
  path: string,
  policy: TrustedSnapshotDirectoryPolicy,
  expected?: QueueDirectoryIdentity,
): QueueDirectoryIdentity {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (
      !opened.isDirectory() ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !policy.allowedUids.includes(opened.uid) ||
      opened.gid !== policy.expectedGid ||
      (opened.mode & 0o777) !== DIRECTORY_MODE ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      (expected &&
        (opened.dev !== expected.dev ||
          opened.ino !== expected.ino ||
          opened.uid !== expected.uid ||
          opened.gid !== expected.gid ||
          (opened.mode & 0o777) !== (expected.mode & 0o777)))
    ) {
      throw new Error(DIRECTORY_REJECTED);
    }
    return {
      dev: opened.dev,
      ino: opened.ino,
      uid: opened.uid,
      gid: opened.gid,
      mode: opened.mode,
    };
  } finally {
    closeSync(fd);
  }
}

function syncDirectoryNow(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validateQueueFile(
  path: string,
  policy: TrustedSnapshotDirectoryPolicy,
  expectedLinks = 1,
): QueueFileIdentity {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    const current = lstatSync(path);
    if (
      !stats.isFile() ||
      stats.nlink !== expectedLinks ||
      stats.dev !== current.dev ||
      stats.ino !== current.ino ||
      !policy.allowedUids.includes(stats.uid) ||
      stats.gid !== policy.expectedGid ||
      (stats.mode & 0o777) !== SNAPSHOT_MODE ||
      stats.size > OPS_TRUSTED_CONFIG_MAX_BYTES
    ) {
      throw new Error(DIRECTORY_REJECTED);
    }
    return {
      size: stats.size,
      bytes: readFileSync(fd),
      dev: stats.dev,
      ino: stats.ino,
      nlink: stats.nlink,
      uid: stats.uid,
      gid: stats.gid,
      mode: stats.mode,
    };
  } finally {
    closeSync(fd);
  }
}

function validateQueue(
  directory: string,
  claimed: string,
  policy: TrustedSnapshotDirectoryPolicy,
  retainAllClaimed = false,
): QueueCleanupPlan[] {
  const cleanup = new Map<string, QueueCleanupEntry>();
  const revisions = new Set<string>();
  const nowMs = policy.nowMs ?? Date.now();
  let entries = 0;
  let bytes = 0;
  let retainedEntries = 0;
  let retainedBytes = 0;
  const journal = journalRevisionIds(policy);
  const directoryIdentity = captureQueueDirectory(directory, policy);
  const claimedIdentity = captureQueueDirectory(claimed, policy);
  const directoryNames = readdirSync(directory);
  const claimedNames = readdirSync(claimed);
  const hardlinkPairs = new Map<
    string,
    {
      rootPath: string;
      claimedPath: string;
      root: QueueFileIdentity;
      claimed: QueueFileIdentity;
    }
  >();
  const publisherAbortPairs = new Map<
    string,
    {
      readyPath: string;
      abortPath: string;
      ready: QueueFileIdentity;
      abort: QueueFileIdentity;
    }
  >();
  for (const name of directoryNames) {
    const match = HARDLINK_ABORT_NAME.exec(name);
    if (!match || !claimedNames.includes(`${match[1]}.json`)) continue;
    if (match[2] === "terminal" && !journal.terminal.has(match[1])) {
      throw new Error(DIRECTORY_REJECTED);
    }
    const rootPath = join(directory, name);
    const claimedPath = join(claimed, `${match[1]}.json`);
    const rootMetadata = validateQueueFile(rootPath, policy, 2);
    const claimedMetadata = validateQueueFile(claimedPath, policy, 2);
    if (
      rootMetadata.dev !== claimedMetadata.dev ||
      rootMetadata.ino !== claimedMetadata.ino ||
      !rootMetadata.bytes.equals(claimedMetadata.bytes)
    ) {
      throw new Error(DIRECTORY_REJECTED);
    }
    hardlinkPairs.set(match[1], {
      rootPath,
      claimedPath,
      root: rootMetadata,
      claimed: claimedMetadata,
    });
  }
  for (const name of directoryNames) {
    if (!ABORT_NAME.test(name)) continue;
    const revisionId = name.slice(1, 49);
    const readyName = `${revisionId}.json`;
    if (!directoryNames.includes(readyName)) continue;
    if (publisherAbortPairs.has(revisionId)) throw new Error(DIRECTORY_REJECTED);
    const readyPath = join(directory, readyName);
    const abortPath = join(directory, name);
    const ready = validateQueueFile(readyPath, policy, 2);
    const abort = validateQueueFile(abortPath, policy, 2);
    if (ready.dev !== abort.dev || ready.ino !== abort.ino || !ready.bytes.equals(abort.bytes)) {
      throw new Error(DIRECTORY_REJECTED);
    }
    publisherAbortPairs.set(revisionId, { readyPath, abortPath, ready, abort });
  }
  for (const name of directoryNames) {
    if (name === ".claimed") continue;
    if (name === OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME) continue;
    if (!SNAPSHOT_NAME.test(name) && !TEMPORARY_NAME.test(name) && !ABORT_NAME.test(name)) {
      throw new Error(DIRECTORY_REJECTED);
    }
    entries += 1;
    const path = join(directory, name);
    const revisionId = SNAPSHOT_NAME.test(name)
      ? name.slice(0, -".json".length)
      : name.slice(1, 49);
    const pair = hardlinkPairs.get(revisionId);
    const publisherPair = publisherAbortPairs.get(revisionId);
    const metadata =
      pair?.root ??
      (publisherPair
        ? path === publisherPair.readyPath
          ? publisherPair.ready
          : publisherPair.abort
        : validateQueueFile(path, policy));
    bytes += metadata.size;
    if (TEMPORARY_NAME.test(name)) {
      cleanup.set(path, {
        path,
        parent: directory,
        parentIdentity: directoryIdentity,
        identity: metadata,
      });
    } else {
      if (revisions.has(revisionId) && !publisherPair) throw new Error(DIRECTORY_REJECTED);
      revisions.add(revisionId);
      const inspected = inspectTrustedConfigurationSnapshot(metadata.bytes, {
        token: policy.token,
      });
      if (inspected.revisionId !== revisionId) throw new Error(DIRECTORY_REJECTED);
      if (
        ABORT_NAME.test(name) ||
        publisherPair ||
        journal.terminal.has(revisionId) ||
        inspected.expiresAtMs <= nowMs
      )
        cleanup.set(path, {
          path,
          parent: directory,
          parentIdentity: directoryIdentity,
          identity: metadata,
        });
      else {
        retainedEntries += 1;
        retainedBytes += metadata.size;
      }
    }
  }
  for (const name of claimedNames) {
    if (!SNAPSHOT_NAME.test(name)) throw new Error(DIRECTORY_REJECTED);
    entries += 1;
    const revisionId = name.slice(0, -".json".length);
    const pair = hardlinkPairs.get(revisionId);
    if (revisions.has(revisionId) && !pair) throw new Error(DIRECTORY_REJECTED);
    revisions.add(revisionId);
    const path = join(claimed, name);
    const metadata = pair?.claimed ?? validateQueueFile(path, policy);
    bytes += metadata.size;
    const inspected = inspectTrustedConfigurationSnapshot(metadata.bytes, { token: policy.token });
    if (inspected.revisionId !== revisionId) throw new Error(DIRECTORY_REJECTED);
    if (!retainAllClaimed && (journal.terminal.has(revisionId) || !journal.all.has(revisionId)))
      cleanup.set(path, {
        path,
        parent: claimed,
        parentIdentity: claimedIdentity,
        identity: metadata,
      });
    else {
      retainedEntries += 1;
      retainedBytes += metadata.size;
    }
  }
  if (
    entries > MAX_SCAN_ENTRIES ||
    bytes > MAX_SCAN_BYTES ||
    !trustedConfigurationQueueFits({
      retainedEntries,
      retainedBytes,
      reservedEntries: 0,
      reservedBytes: 0,
    })
  ) {
    throw new Error(DIRECTORY_REJECTED);
  }
  captureQueueDirectory(directory, policy, directoryIdentity);
  captureQueueDirectory(claimed, policy, claimedIdentity);
  const plans: QueueCleanupPlan[] = [];
  const pairedPaths = new Set<string>();
  for (const pair of hardlinkPairs.values()) {
    const rootCleanup = cleanup.get(pair.rootPath);
    const claimedCleanup = cleanup.get(pair.claimedPath);
    if (Boolean(rootCleanup) !== Boolean(claimedCleanup)) throw new Error(DIRECTORY_REJECTED);
    if (rootCleanup && claimedCleanup) {
      plans.push({ first: rootCleanup, second: claimedCleanup });
      pairedPaths.add(rootCleanup.path);
      pairedPaths.add(claimedCleanup.path);
    }
  }
  for (const pair of publisherAbortPairs.values()) {
    const readyCleanup = cleanup.get(pair.readyPath);
    const abortCleanup = cleanup.get(pair.abortPath);
    if (!readyCleanup || !abortCleanup) throw new Error(DIRECTORY_REJECTED);
    plans.push({ first: readyCleanup, second: abortCleanup });
    pairedPaths.add(readyCleanup.path);
    pairedPaths.add(abortCleanup.path);
  }
  for (const candidate of cleanup.values()) {
    if (!pairedPaths.has(candidate.path)) plans.push({ first: candidate });
  }
  return plans;
}

function sameQueueFile(
  current: QueueFileIdentity,
  expected: QueueFileIdentity,
  expectedLinks: number,
): boolean {
  return (
    current.nlink === expectedLinks &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.uid === expected.uid &&
    current.gid === expected.gid &&
    (current.mode & 0o777) === (expected.mode & 0o777) &&
    current.size === expected.size &&
    current.bytes.equals(expected.bytes)
  );
}

function revalidateCleanupEntry(
  entry: QueueCleanupEntry,
  policy: TrustedSnapshotDirectoryPolicy,
  expectedLinks: number,
): QueueFileIdentity {
  captureQueueDirectory(entry.parent, policy, entry.parentIdentity);
  const current = validateQueueFile(entry.path, policy, expectedLinks);
  if (!sameQueueFile(current, entry.identity, expectedLinks)) {
    throw new Error(DIRECTORY_REJECTED);
  }
  return current;
}

function assertMissing(path: string): void {
  try {
    lstatSync(path);
    throw new Error(DIRECTORY_REJECTED);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function initializeTrustedSnapshotDirectory(
  directory: string,
  policy: TrustedSnapshotDirectoryPolicy,
): Promise<void> {
  let queueLock: Awaited<ReturnType<typeof acquireTrustedConfigurationQueueLock>> | undefined;
  try {
    if (!directoryIsSafe(directory, policy)) throw new Error(DIRECTORY_REJECTED);
    const directoryOwner = lstatSync(directory).uid;
    queueLock = await acquireTrustedConfigurationQueueLock({
      directory,
      token: policy.token,
      ownerUid: directoryOwner,
      ownerGid: policy.expectedGid,
      participant: "ops-agent",
      operationKey: "startup",
    });
    const claimed = join(directory, ".claimed");
    try {
      lstatSync(claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(claimed, { mode: DIRECTORY_MODE });
    }
    if (!directoryIsSafe(claimed, policy)) throw new Error(DIRECTORY_REJECTED);
    // First validate every entry and both aggregate bounds. Cleanup only
    // begins after the complete scan, so an unknown or unsafe object cannot
    // trick startup into deleting another entry before it fails closed.
    const cleanup = validateQueue(directory, claimed, policy);
    for (const plan of cleanup) {
      revalidateCleanupEntry(plan.first, policy, plan.second ? 2 : 1);
      if (plan.second) {
        const second = revalidateCleanupEntry(plan.second, policy, 2);
        const first = revalidateCleanupEntry(plan.first, policy, 2);
        if (
          first.dev !== second.dev ||
          first.ino !== second.ino ||
          !first.bytes.equals(second.bytes)
        ) {
          throw new Error(DIRECTORY_REJECTED);
        }
      }
      policy.beforeCleanupUnlink?.(plan.first.path);
      queueLock.assertHeld();
      revalidateCleanupEntry(plan.first, policy, plan.second ? 2 : 1);
      if (plan.second) revalidateCleanupEntry(plan.second, policy, 2);
      unlinkSync(plan.first.path);
      syncDirectoryNow(plan.first.parent);
      if (plan.second) {
        assertMissing(plan.first.path);
        revalidateCleanupEntry(plan.second, policy, 1);
        policy.beforeCleanupUnlink?.(plan.second.path);
        queueLock.assertHeld();
        assertMissing(plan.first.path);
        revalidateCleanupEntry(plan.second, policy, 1);
        unlinkSync(plan.second.path);
        syncDirectoryNow(plan.second.parent);
      }
    }
  } catch {
    throw new Error(DIRECTORY_REJECTED);
  } finally {
    try {
      queueLock?.release();
    } catch {
      // biome-ignore lint/correctness/noUnsafeFinally: lock interference must fail startup closed
      throw new Error(DIRECTORY_REJECTED);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function revisionFor(operation: Parameters<TrustedOpsDataSource["claim"]>[0]): string | null {
  if (!("revisionId" in operation) || typeof operation.revisionId !== "string") return null;
  return /^cfg1_[A-Za-z0-9_-]{43}$/.test(operation.revisionId) ? operation.revisionId : null;
}

export interface FileTrustedOpsDataSourceOptions extends TrustedSnapshotDirectoryPolicy {
  directory: string;
  now?: () => number;
  afterClaimRename?: () => Promise<void>;
  beforeClaimRename?: () => Promise<void>;
  afterTerminalLink?: () => Promise<void>;
  afterTerminalSourceUnlink?: () => Promise<void>;
}

export interface FileTrustedOpsDataSource {
  claim(
    operation: OpsOperation,
    fingerprint: string,
    signal: AbortSignal,
    owner?: OpsClaimOwner,
  ): Promise<{
    capability: OpsTrustedClaim["capability"];
    admission: NonNullable<OpsTrustedClaim["admission"]>;
  } | null>;
}

interface ClaimLease {
  readers: number;
  committed: boolean;
  removing: boolean;
  abortableClaimed: boolean;
}

export function createFileTrustedOpsDataSource(
  options: FileTrustedOpsDataSourceOptions,
): FileTrustedOpsDataSource {
  const claimedDirectory = join(options.directory, ".claimed");
  const leases = new Map<string, ClaimLease>();
  return {
    claim: async (operation, fingerprint, signal, owner) => {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let lease: { key: string; value: ClaimLease } | undefined;
      let admissionCreated = false;
      let queueLock: Awaited<ReturnType<typeof acquireTrustedConfigurationQueueLock>> | undefined;
      try {
        if (signal.aborted || !owner || owner.role !== "api") return null;
        if (
          !directoryIsSafe(options.directory, options) ||
          !directoryIsSafe(claimedDirectory, options)
        ) {
          return null;
        }
        const revisionId = revisionFor(operation);
        if (!revisionId) return null;
        queueLock = await acquireTrustedConfigurationQueueLock({
          directory: options.directory,
          token: options.token,
          ownerUid: lstatSync(options.directory).uid,
          ownerGid: options.expectedGid,
          participant: "ops-agent",
          operationKey: owner.operationKey,
        });
        validateQueue(
          options.directory,
          claimedDirectory,
          { ...options, nowMs: options.now?.() },
          true,
        );
        queueLock.assertHeld();
        const readyPath = join(options.directory, `${revisionId}.json`);
        const claimedPath = join(claimedDirectory, `${revisionId}.json`);
        let candidatePath = readyPath;
        try {
          handle = await open(readyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          ) {
            throw error;
          }
          candidatePath = claimedPath;
          handle = await open(claimedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          !options.allowedUids.includes(stats.uid) ||
          stats.gid !== options.expectedGid ||
          (stats.mode & 0o777) !== SNAPSHOT_MODE ||
          stats.size < 2 ||
          stats.size > OPS_TRUSTED_CONFIG_MAX_BYTES
        ) {
          return null;
        }
        const leaseKey = `${stats.dev}:${stats.ino}`;
        const leaseValue = leases.get(leaseKey) ?? {
          readers: 0,
          committed: false,
          removing: false,
          abortableClaimed: false,
        };
        if (leaseValue.removing) return null;
        leaseValue.readers += 1;
        leases.set(leaseKey, leaseValue);
        lease = { key: leaseKey, value: leaseValue };
        const bytes = await handle.readFile();
        const opened = openTrustedConfigurationSnapshot(bytes, {
          role: owner.role,
          operationKey: owner.operationKey,
          operation,
          fingerprint,
          token: options.token,
          nowMs: options.now?.(),
        });
        if (candidatePath === readyPath) {
          try {
            try {
              await lstat(claimedPath);
              throw new Error();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const ready = await lstat(readyPath);
            if (ready.dev !== stats.dev || ready.ino !== stats.ino) throw new Error();
            await options.beforeClaimRename?.();
            queueLock.assertHeld();
            const unchanged = await lstat(readyPath);
            if (unchanged.dev !== stats.dev || unchanged.ino !== stats.ino) throw new Error();
            await rename(readyPath, claimedPath);
            candidatePath = claimedPath;
            leaseValue.abortableClaimed = true;
            const claimed = await lstat(claimedPath);
            if (claimed.dev !== stats.dev || claimed.ino !== stats.ino) throw new Error();
            await syncDirectory(options.directory);
            await syncDirectory(claimedDirectory);
            await options.afterClaimRename?.();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const claimed = await lstat(claimedPath);
            if (claimed.dev !== stats.dev || claimed.ino !== stats.ino) throw error;
            candidatePath = claimedPath;
          }
        }
        let state: "pending" | "committed" | "rolled_back" | "released" = "pending";
        const settleReader = (): boolean => {
          if (!lease || state !== "pending") return false;
          lease.value.readers -= 1;
          return true;
        };
        const removeExact = async (includeClaimed: boolean, terminal: boolean): Promise<void> => {
          const tombstonePath = join(
            options.directory,
            `.${revisionId}.${terminal ? "terminal" : "rollback"}.abort`,
          );
          const retained: Array<{ path: string; directory: string; stats: Stats }> = [];
          for (const [path, directory] of [
            ...(includeClaimed ? ([[claimedPath, claimedDirectory]] as const) : []),
            [readyPath, options.directory] as const,
          ]) {
            try {
              retained.push({ path, directory, stats: await lstat(path) });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          if (retained.length > 1) throw new Error();
          const source = retained[0];
          let tombstone: Stats | undefined;
          try {
            tombstone = await lstat(tombstonePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (!source && !tombstone) return;
          const exact = (value: Stats, links: number): boolean =>
            value.isFile() &&
            value.nlink === links &&
            value.dev === stats.dev &&
            value.ino === stats.ino &&
            options.allowedUids.includes(value.uid) &&
            value.gid === options.expectedGid &&
            (value.mode & 0o777) === SNAPSHOT_MODE;
          if (source && !tombstone) {
            if (!exact(source.stats, 1)) throw new Error();
            linkSync(source.path, tombstonePath);
            await syncDirectory(options.directory);
            if (source.directory !== options.directory) await syncDirectory(source.directory);
            await options.afterTerminalLink?.();
            tombstone = await lstat(tombstonePath);
          }
          if (source) {
            const currentSource = await lstat(source.path);
            const currentTombstone = await lstat(tombstonePath);
            if (!exact(currentSource, 2) || !exact(currentTombstone, 2)) throw new Error();
            unlinkSync(source.path);
            await syncDirectory(source.directory);
            await options.afterTerminalSourceUnlink?.();
            tombstone = await lstat(tombstonePath);
          }
          if (!tombstone || !exact(tombstone, 1)) throw new Error();
          unlinkSync(tombstonePath);
          await syncDirectory(options.directory);
        };
        const resolved = {
          capability: {
            revisionId,
            values: {},
            trustedConfiguration: opened.payload,
          },
          admission: {
            rollback: async () => {
              if (!settleReader()) return;
              state = "rolled_back";
              if (!lease || lease.value.committed || lease.value.readers !== 0) {
                if (lease && lease.value.readers === 0) leases.delete(lease.key);
                return;
              }
              lease.value.removing = true;
              try {
                if (candidatePath === claimedPath && !lease.value.abortableClaimed) return;
                await removeExact(lease.value.abortableClaimed, false);
              } catch {
                throw new Error("Trusted configuration rollback failed");
              } finally {
                leases.delete(lease.key);
              }
            },
            commit: async () => {
              if (state === "committed") return;
              if (!settleReader() || !lease) throw new Error("Trusted configuration claim failed");
              state = "committed";
              lease.value.committed = true;
              try {
                const claimed = await lstat(claimedPath);
                if (claimed.dev !== stats.dev || claimed.ino !== stats.ino) throw new Error();
              } catch {
                throw new Error("Trusted configuration claim failed");
              } finally {
                if (lease.value.readers === 0) leases.delete(lease.key);
              }
            },
            release: async () => {
              if (state === "released") return;
              try {
                if (state === "pending") settleReader();
                await removeExact(true, true);
                state = "released";
              } catch {
                throw new Error("Trusted configuration release failed");
              } finally {
                if (lease && lease.value.readers === 0) leases.delete(lease.key);
              }
            },
          },
        };
        admissionCreated = true;
        return resolved;
      } catch {
        return null;
      } finally {
        if (lease && !admissionCreated) {
          lease.value.readers -= 1;
          if (lease.value.readers === 0) leases.delete(lease.key);
        }
        await handle?.close().catch(() => undefined);
        try {
          queueLock?.release();
        } catch {
          // biome-ignore lint/correctness/noUnsafeFinally: lock interference invalidates the claim
          throw new Error("Trusted configuration claim failed");
        }
      }
    },
  };
}
