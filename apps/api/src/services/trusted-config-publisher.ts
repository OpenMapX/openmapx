import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireTrustedConfigurationQueueLock,
  inspectTrustedConfigurationSnapshot,
  OPS_TRUSTED_CONFIG_MAX_BYTES,
  OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME,
  type SealTrustedConfigurationSnapshotOptions,
  sealTrustedConfigurationSnapshot,
  type TrustedConfigurationPayload,
  trustedConfigurationQueueFits,
} from "@openmapx/core/ops";

const DIRECTORY_MODE = 0o700;
const SNAPSHOT_MODE = 0o600;
const REJECTED = "Trusted configuration snapshot publish failed";
const MAX_SCAN_ENTRIES = 1_024;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const SNAPSHOT_NAME = /^cfg1_[A-Za-z0-9_-]{43}\.json$/;
const TEMPORARY_NAME = /^\.cfg1_[A-Za-z0-9_-]{43}\.nonce_[A-Za-z0-9_-]{16,96}\.tmp$/;
const ABORT_NAME = /^\.cfg1_[A-Za-z0-9_-]{43}\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.abort$/;
let publicationLock: Promise<void> = Promise.resolve();

export interface SnapshotPublishDependencies {
  beforeRename(): Promise<void>;
  beforeAbortRename(): Promise<void>;
  afterAbortLink(): Promise<void>;
  afterAbortLinkSync(): Promise<void>;
  afterAbortSourceUnlink(): Promise<void>;
  afterAbortSourceSync(): Promise<void>;
  afterAbortTombstoneUnlink(): Promise<void>;
  afterAbortTombstoneSync(): Promise<void>;
}

export interface PublishTrustedConfigurationSnapshotOptions {
  directory: string;
  token: string;
  ownerUid: number;
  ownerGid: number;
  operationKey: string;
  operationForRevision: SealTrustedConfigurationSnapshotOptions["operationForRevision"];
  payload: TrustedConfigurationPayload;
  now?: () => number;
  nonce?: () => string;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validateDirectory(path: string, ownerUid: number, ownerGid: number): Promise<void> {
  const stats = await lstat(path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.gid !== ownerGid ||
    stats.uid !== ownerUid ||
    (stats.mode & 0o777) !== (DIRECTORY_MODE & 0o777)
  ) {
    throw new Error(REJECTED);
  }
}

async function withPublicationLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = publicationLock;
  let release!: () => void;
  publicationLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

async function assertReadyCapacity(
  directory: string,
  ownerUid: number,
  ownerGid: number,
  token: string,
  incomingBytes: number,
): Promise<void> {
  let entries = 0;
  let bytes = 0;
  let scannedEntries = 0;
  let scannedBytes = 0;
  const revisions = new Set<string>();
  const inspectRetainedSnapshot = async (
    path: string,
    expectedRevision: string,
  ): Promise<number> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      const current = await lstat(path);
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.dev !== current.dev ||
        stats.ino !== current.ino ||
        stats.uid !== ownerUid ||
        stats.gid !== ownerGid ||
        (stats.mode & 0o777) !== SNAPSHOT_MODE ||
        stats.size > OPS_TRUSTED_CONFIG_MAX_BYTES
      ) {
        throw new Error(REJECTED);
      }
      const bytes = await handle.readFile();
      const inspected = inspectTrustedConfigurationSnapshot(bytes, { token });
      if (inspected.revisionId !== expectedRevision) throw new Error(REJECTED);
      return stats.size;
    } finally {
      await handle.close();
    }
  };

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME) continue;
    if (entry.name === ".claimed") {
      await validateDirectory(join(directory, entry.name), ownerUid, ownerGid);
      for (const claimedEntry of await readdir(join(directory, entry.name), {
        withFileTypes: true,
      })) {
        if (!claimedEntry.isFile() || !SNAPSHOT_NAME.test(claimedEntry.name)) {
          throw new Error(REJECTED);
        }
        const revisionId = claimedEntry.name.slice(0, -".json".length);
        if (revisions.has(revisionId)) throw new Error(REJECTED);
        revisions.add(revisionId);
        const size = await inspectRetainedSnapshot(
          join(directory, entry.name, claimedEntry.name),
          revisionId,
        );
        scannedEntries += 1;
        scannedBytes += size;
        entries += 1;
        bytes += size;
      }
      continue;
    }
    if (
      !entry.isFile() ||
      (!SNAPSHOT_NAME.test(entry.name) &&
        !TEMPORARY_NAME.test(entry.name) &&
        !ABORT_NAME.test(entry.name))
    ) {
      throw new Error(REJECTED);
    }
    const stats = await lstat(join(directory, entry.name));
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.uid !== ownerUid ||
      stats.gid !== ownerGid ||
      (stats.mode & 0o777) !== SNAPSHOT_MODE ||
      stats.size > OPS_TRUSTED_CONFIG_MAX_BYTES
    ) {
      throw new Error(REJECTED);
    }
    scannedEntries += 1;
    scannedBytes += stats.size;
    if (scannedEntries > MAX_SCAN_ENTRIES || scannedBytes > MAX_SCAN_BYTES) {
      throw new Error(REJECTED);
    }
    if (SNAPSHOT_NAME.test(entry.name)) {
      const revisionId = entry.name.slice(0, -".json".length);
      if (revisions.has(revisionId)) throw new Error(REJECTED);
      revisions.add(revisionId);
      const retainedSize = await inspectRetainedSnapshot(join(directory, entry.name), revisionId);
      entries += 1;
      bytes += retainedSize;
    } else if (ABORT_NAME.test(entry.name)) {
      const revisionId = entry.name.slice(1, 49);
      if (revisions.has(revisionId)) throw new Error(REJECTED);
      revisions.add(revisionId);
      await inspectRetainedSnapshot(join(directory, entry.name), revisionId);
    }
  }
  if (
    scannedEntries > MAX_SCAN_ENTRIES ||
    scannedBytes > MAX_SCAN_BYTES ||
    !trustedConfigurationQueueFits({
      retainedEntries: entries,
      retainedBytes: bytes,
      reservedEntries: 1,
      reservedBytes: incomingBytes,
    })
  ) {
    throw new Error(REJECTED);
  }
}

function contentDigest(bytes: Uint8Array): Buffer {
  return createHash("sha256")
    .update("openmapx-trusted-config-publisher-candidate-v1\0")
    .update(bytes)
    .digest();
}

export async function publishTrustedConfigurationSnapshot(
  options: PublishTrustedConfigurationSnapshotOptions,
  dependencies: Partial<SnapshotPublishDependencies> = {},
) {
  return withPublicationLock(async () => {
    let temporary: string | undefined;
    let queueLock: Awaited<ReturnType<typeof acquireTrustedConfigurationQueueLock>> | undefined;
    try {
      await validateDirectory(options.directory, options.ownerUid, options.ownerGid);
      const nowMs = options.now?.();
      queueLock = await acquireTrustedConfigurationQueueLock({
        directory: options.directory,
        token: options.token,
        ownerUid: options.ownerUid,
        ownerGid: options.ownerGid,
        participant: "api",
        operationKey: options.operationKey,
      });
      const nonce = options.nonce?.() ?? `nonce_${randomUUID().replaceAll("-", "")}`;
      const sealed = sealTrustedConfigurationSnapshot({
        role: "api",
        operationKey: options.operationKey,
        operationForRevision: options.operationForRevision,
        payload: options.payload,
        token: options.token,
        issuedAtMs: nowMs,
        nonce,
      });
      await assertReadyCapacity(
        options.directory,
        options.ownerUid,
        options.ownerGid,
        options.token,
        sealed.bytes.byteLength,
      );
      queueLock.assertHeld();
      const finalPath = join(options.directory, `${sealed.revisionId}.json`);
      temporary = join(options.directory, `.${sealed.revisionId}.${nonce}.tmp`);
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        SNAPSHOT_MODE,
      );
      try {
        await handle.writeFile(sealed.bytes);
        await handle.chmod(SNAPSHOT_MODE);
        await handle.chown(options.ownerUid, options.ownerGid);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await dependencies.beforeRename?.();
      queueLock.assertHeld();
      await link(temporary, finalPath);
      await unlink(temporary);
      temporary = undefined;
      await syncDirectory(options.directory);
      const publishedStats = await lstat(finalPath);
      const expectedDigest = contentDigest(sealed.bytes);
      const abortPath = join(options.directory, `.${sealed.revisionId}.${nonce}.abort`);
      let aborted = false;
      let abortInFlight: Promise<void> | undefined;
      const validateCandidate = async (
        path: string,
        expectedLinks: number,
      ): Promise<{ dev: number; ino: number }> => {
        const candidateHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stats = await candidateHandle.stat();
          const current = await lstat(path);
          const bytes = await candidateHandle.readFile();
          const actualDigest = contentDigest(bytes);
          if (
            !stats.isFile() ||
            stats.nlink !== expectedLinks ||
            stats.dev !== current.dev ||
            stats.ino !== current.ino ||
            stats.dev !== publishedStats.dev ||
            stats.ino !== publishedStats.ino ||
            stats.uid !== options.ownerUid ||
            stats.gid !== options.ownerGid ||
            (stats.mode & 0o777) !== SNAPSHOT_MODE ||
            stats.size !== sealed.bytes.byteLength ||
            actualDigest.byteLength !== expectedDigest.byteLength ||
            !timingSafeEqual(actualDigest, expectedDigest)
          ) {
            throw new Error(REJECTED);
          }
          return { dev: stats.dev, ino: stats.ino };
        } finally {
          await candidateHandle.close();
        }
      };
      const pathExists = async (path: string): Promise<boolean> => {
        try {
          await lstat(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      const assertMissing = async (path: string): Promise<void> => {
        try {
          await lstat(path);
          throw new Error(REJECTED);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
      const runAbort = async (): Promise<void> => {
        await dependencies.beforeAbortRename?.();
        const finalExists = await pathExists(finalPath);
        const tombstoneExists = await pathExists(abortPath);
        if (!finalExists && !tombstoneExists) {
          await syncDirectory(options.directory);
          aborted = true;
          return;
        }
        let final: { dev: number; ino: number } | undefined;
        let tombstone: { dev: number; ino: number } | undefined;
        if (finalExists && tombstoneExists) {
          final = await validateCandidate(finalPath, 2);
          tombstone = await validateCandidate(abortPath, 2);
          if (final.dev !== tombstone.dev || final.ino !== tombstone.ino) {
            throw new Error(REJECTED);
          }
        } else if (finalExists) {
          final = await validateCandidate(finalPath, 1);
          try {
            await link(finalPath, abortPath);
          } catch {
            throw new Error(REJECTED);
          }
          await dependencies.afterAbortLink?.();
          final = await validateCandidate(finalPath, 2);
          tombstone = await validateCandidate(abortPath, 2);
          if (final.dev !== tombstone.dev || final.ino !== tombstone.ino) {
            throw new Error(REJECTED);
          }
          await syncDirectory(options.directory);
          await dependencies.afterAbortLinkSync?.();
        } else {
          tombstone = await validateCandidate(abortPath, 1);
        }
        if (final) {
          const currentFinal = await validateCandidate(finalPath, 2);
          const currentTombstone = await validateCandidate(abortPath, 2);
          if (
            currentFinal.dev !== currentTombstone.dev ||
            currentFinal.ino !== currentTombstone.ino
          ) {
            throw new Error(REJECTED);
          }
          await unlink(finalPath);
          await dependencies.afterAbortSourceUnlink?.();
          await syncDirectory(options.directory);
          await dependencies.afterAbortSourceSync?.();
        }
        await assertMissing(finalPath);
        await validateCandidate(abortPath, 1);
        await unlink(abortPath);
        await dependencies.afterAbortTombstoneUnlink?.();
        await syncDirectory(options.directory);
        await dependencies.afterAbortTombstoneSync?.();
        aborted = true;
      };
      const abort = async (): Promise<void> => {
        if (aborted) return;
        if (abortInFlight) return abortInFlight;
        const attempt = runAbort().catch(() => {
          throw new Error(REJECTED);
        });
        abortInFlight = attempt;
        try {
          await attempt;
        } finally {
          if (!aborted) abortInFlight = undefined;
        }
      };
      return { ...sealed, mode: SNAPSHOT_MODE, abort };
    } catch {
      if (temporary) await unlink(temporary).catch(() => undefined);
      throw new Error(REJECTED);
    } finally {
      try {
        queueLock?.release();
      } catch {
        // biome-ignore lint/correctness/noUnsafeFinally: lock interference must fail closed
        throw new Error(REJECTED);
      }
    }
  });
}

export async function consumePublishedTrustedConfiguration<T>(
  published: { abort(): Promise<void> },
  submit: () => Promise<T>,
): Promise<T> {
  try {
    return await submit();
  } finally {
    await published.abort();
  }
}
