/** Checked metadata only; publication here selects no images and grants no effects. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite, fsyncDirectory } from "../release-files";
import { canonicalReleaseManifest, type ReleaseManifest } from "./release-manifest";
import type { ReleaseSelection } from "./release-selection";
import {
  assertReleaseStateDirectory,
  parseReleaseSelectionReceipts,
  RELEASE_ID_PATTERN,
  RELEASE_MANIFEST_FILE_PATTERN,
  RELEASE_STORE_LIMITS,
  RELEASE_STORE_POINTER_FILES,
  type ReleaseStateOptions,
  readReleaseStateFile,
  releaseStateFileProblem,
  releaseStatePaths,
} from "./release-state";
import {
  assertReleaseStoreLock,
  RELEASE_STORE_LOCK_NAME,
  type ReleaseStoreLock,
} from "./release-store-lock";

const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");

export function releaseConfigurationIdentity(selection: ReleaseSelection): string {
  return digest(JSON.stringify(selection));
}

/** Same bounded enumeration used by legacy resolution and inspection. */
export function listReleaseStoreManifests(
  directory: string,
  options: ReleaseStateOptions = {},
): string[] {
  assertReleaseStateDirectory(directory, options);
  const entries = readdirSync(directory);
  if (entries.length > RELEASE_STORE_LIMITS.entries + 5)
    throw Error("Release store limit exceeded");
  const names: string[] = [];
  let bytes = 0;
  for (const name of entries) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (name === RELEASE_STORE_LOCK_NAME) {
      const uid = options.uid ?? process.geteuid?.();
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o022) !== 0
      )
        throw Error("Release store contains an unsafe entry");
      continue;
    }
    if ((RELEASE_STORE_POINTER_FILES as readonly string[]).includes(name)) {
      const maximum =
        name === "transaction.json"
          ? RELEASE_STORE_LIMITS.transactionBytes
          : name === "selections.json"
            ? RELEASE_STORE_LIMITS.selectionsBytes
            : RELEASE_STORE_LIMITS.stateBytes;
      if (stat.size < 1 || releaseStateFileProblem(stat, maximum, options))
        throw Error("Release store contains an unsafe entry");
      continue;
    }
    const releaseId = RELEASE_MANIFEST_FILE_PATTERN.exec(name)?.[1];
    if (
      !releaseId ||
      stat.size < 1 ||
      releaseStateFileProblem(stat, RELEASE_STORE_LIMITS.manifestBytes, options)
    )
      throw Error("Release store contains an unsafe entry");
    bytes += stat.size;
    if (
      bytes > RELEASE_STORE_LIMITS.entries * RELEASE_STORE_LIMITS.manifestBytes ||
      names.length >= RELEASE_STORE_LIMITS.entries
    )
      throw Error("Release store limit exceeded");
    names.push(releaseId);
  }
  return names;
}

function immutableWrite(path: string, raw: string, options: ReleaseStateOptions) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, raw, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let failure: unknown;
  try {
    linkSync(temporary, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") failure = error;
    else {
      try {
        if (readReleaseStateFile(path, RELEASE_STORE_LIMITS.manifestBytes, options) !== raw)
          throw Error("Release authority rejected");
      } catch (readError) {
        failure = readError;
      }
    }
  }
  try {
    unlinkSync(temporary);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && failure === undefined)
      failure = error;
  }
  if (failure !== undefined) throw failure;
}

/** Caller already owns the actual release-store lock. Transaction policy is its own. */
export function cacheCheckedReleaseManifest(input: {
  infraDir: string;
  manifest: ReleaseManifest;
  ociDigest: string;
  configurationIdentity: string;
  lock: ReleaseStoreLock;
  uid?: number;
}): { releaseId: string; manifestDigest: string } {
  const paths = releaseStatePaths(input.infraDir);
  const options = { uid: input.uid };
  assertReleaseStateDirectory(paths.directory, options);
  assertReleaseStateDirectory(paths.store, options);
  assertReleaseStoreLock(input.lock, paths.store);
  if (
    !RELEASE_ID_PATTERN.test(input.manifest.release) ||
    (RELEASE_STORE_POINTER_FILES as readonly string[]).includes(`${input.manifest.release}.json`) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.ociDigest) ||
    !/^[a-f0-9]{64}$/.test(input.configurationIdentity)
  )
    throw Error("Invalid or reserved checked release identity");
  const canonical = canonicalReleaseManifest(input.manifest);
  if (Buffer.byteLength(canonical) > RELEASE_STORE_LIMITS.manifestBytes)
    throw Error("Release manifest limit exceeded");
  const names = listReleaseStoreManifests(paths.store, options);
  if (!names.includes(input.manifest.release) && names.length >= RELEASE_STORE_LIMITS.entries)
    throw Error("Release store limit exceeded");
  let receipts = {};
  try {
    receipts = parseReleaseSelectionReceipts(
      readReleaseStateFile(
        join(paths.store, "selections.json"),
        RELEASE_STORE_LIMITS.selectionsBytes,
        options,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifestDigest = digest(canonical);
  const updated = parseReleaseSelectionReceipts(
    JSON.stringify({
      ...receipts,
      [input.manifest.release]: {
        configuration: input.configurationIdentity,
        ociDigest: input.ociDigest,
        digest: manifestDigest,
      },
    }),
  );
  immutableWrite(join(paths.store, `${input.manifest.release}.json`), canonical, options);
  atomicWrite(join(paths.store, "selections.json"), JSON.stringify(updated));
  atomicWrite(
    join(paths.store, "latest.json"),
    JSON.stringify({ releaseId: input.manifest.release, digest: manifestDigest }),
  );
  return { releaseId: input.manifest.release, manifestDigest };
}
