import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { readRegularFileBytes } from "./built-in-service-source";
import { communityServiceManifestProblems } from "./community-manifest";
import type { LoadedService, ServiceManifest } from "./types";

/**
 * The operations agent's records of the community service repositories it
 * installed under `services/.community/`.
 *
 * Each record lists, for every service the agent validated when it installed
 * a commit, the manifest's directory in the repository and the SHA-256 of its
 * bytes. Readers trust a repository's services by those digests: a manifest
 * whose bytes differ, or one the record does not list, is never loaded. The
 * agent writes each record itself, so a record must be a regular file owned
 * by the reading uid that nobody else can write; a checkout's file permissions
 * play no other part.
 */

export const COMMUNITY_RECORD_VERSION = 2;

const REPOSITORY = /^[a-f0-9]{16}$/;
const TRANSACTION = /^txn1_[a-f0-9]{24}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RECORD = /^\.repository-([a-f0-9]{16})\.json$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RECORDED_MANIFESTS = 64;
const MAX_PATH_DEPTH = 4;
const MAX_SEGMENT_LENGTH = 255;
const MAX_REPOSITORIES = 256;
const MAX_MANIFESTS = 256;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TOTAL_MANIFEST_BYTES = 16 * 1024 * 1024;
const FAILED = "Community service records rejected";

/**
 * Why the agent's community service records cannot be loaded, worded for the
 * operator: the CLI prints the message as it is.
 */
export class CommunityServiceRecordsError extends Error {
  constructor(message: string = FAILED) {
    super(message);
    this.name = "CommunityServiceRecordsError";
  }
}

function recovery(repository: string): string {
  return (
    `Delete services/.community/${repository} and services/.community/${communityRecordFileName(repository)}, ` +
    "then install its extension again."
  );
}

/** One service manifest the agent validated: its directory in the repository and its digest. */
export interface RecordedManifest {
  /** Directory holding `service.json`, relative to the repository root ("" for the root). */
  path: string;
  sha256: string;
}

export interface CommunityRepositorySource {
  url: string | null;
  commit: string | null;
  extensionId: string | null;
  /** The manifests of `commit`; `null` when no checkout is installed. */
  manifests: RecordedManifest[] | null;
}

export interface CommunityRepositoryRecovery {
  selectionBefore: string[] | null;
  touchedServiceIds: string[];
  previouslyEnabledServiceIds: string[];
}

export interface CommunityRepositoryPending {
  transactionId: string;
  /**
   * `prepared` until the new checkout is in place, `published` until settled,
   * and `rolledBack` once the previous checkout is restored, until released.
   */
  phase: "prepared" | "published" | "rolledBack";
  /** What the checkout held before; null when the repository is new. */
  previous: CommunityRepositorySource | null;
  next: { url: string; commit: string; extensionId: string; manifests: RecordedManifest[] };
  recovery: CommunityRepositoryRecovery;
}

export interface CommunityRepositoryRecord extends CommunityRepositorySource {
  version: typeof COMMUNITY_RECORD_VERSION;
  repository: string;
  pending: CommunityRepositoryPending | null;
}

export function communityRecordFileName(repository: string): string {
  return `.repository-${repository}.json`;
}

/** The repository a record file name names, or `null` for any other entry. */
export function communityRecordRepository(name: string): string | null {
  return RECORD.exec(name)?.[1] ?? null;
}

export function manifestSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validManifestPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path === "") return true;
  const segments = path.split("/");
  return (
    segments.length <= MAX_PATH_DEPTH &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= MAX_SEGMENT_LENGTH &&
        !segment.startsWith(".") &&
        !segment.includes("\0") &&
        !segment.includes("\\"),
    )
  );
}

function parseManifests(value: unknown): RecordedManifest[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECORDED_MANIFESTS) {
    return undefined;
  }
  const manifests: RecordedManifest[] = [];
  const paths = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const { path, sha256 } = item as Record<string, unknown>;
    if (!validManifestPath(path) || typeof sha256 !== "string" || !SHA256.test(sha256)) {
      return undefined;
    }
    if (paths.has(path)) return undefined;
    paths.add(path);
    manifests.push({ path, sha256 });
  }
  return manifests;
}

function parseSource(value: unknown): CommunityRepositorySource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const { url, commit, extensionId } = source;
  const manifests = parseManifests(source.manifests);
  if (url !== null && typeof url !== "string") return null;
  if (commit !== null && (typeof commit !== "string" || !COMMIT.test(commit))) return null;
  if (extensionId !== null && (typeof extensionId !== "string" || !SERVICE_ID.test(extensionId)))
    return null;
  if (manifests === undefined || (manifests !== null && (url === null || commit === null))) {
    return null;
  }
  return {
    url: url as string | null,
    commit: commit as string | null,
    extensionId: extensionId as string | null,
    manifests,
  };
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= 256 &&
    value.every((item) => typeof item === "string" && SERVICE_ID.test(item))
    ? [...value]
    : null;
}

/** Parses a record for `repository`, or throws. */
export function parseCommunityRepositoryRecord(
  raw: unknown,
  repository: string,
): CommunityRepositoryRecord {
  const rejected = new Error(`Repository record ${repository} is invalid`);
  if (!raw || typeof raw !== "object") throw rejected;
  const record = raw as Record<string, unknown>;
  const source = parseSource(record);
  if (
    record.version !== COMMUNITY_RECORD_VERSION ||
    record.repository !== repository ||
    !REPOSITORY.test(repository) ||
    !source
  ) {
    throw rejected;
  }
  let pending: CommunityRepositoryPending | null = null;
  if (record.pending !== null) {
    const value = record.pending as Record<string, unknown> | undefined;
    const next = value && parseSource(value.next);
    const recovery = value?.recovery as Record<string, unknown> | undefined;
    const touched = stringList(recovery?.touchedServiceIds);
    const enabled = stringList(recovery?.previouslyEnabledServiceIds);
    const before =
      recovery?.selectionBefore === null ? null : stringList(recovery?.selectionBefore);
    if (
      !value ||
      typeof value.transactionId !== "string" ||
      !TRANSACTION.test(value.transactionId) ||
      (value.phase !== "prepared" && value.phase !== "published" && value.phase !== "rolledBack") ||
      !next?.url ||
      !next.commit ||
      !next.extensionId ||
      !next.manifests ||
      !touched ||
      !enabled ||
      (recovery?.selectionBefore !== null && !before)
    ) {
      throw rejected;
    }
    const previous = value.previous === null ? null : parseSource(value.previous);
    if (value.previous !== null && !previous) throw rejected;
    pending = {
      transactionId: value.transactionId,
      phase: value.phase,
      previous,
      next: {
        url: next.url,
        commit: next.commit,
        extensionId: next.extensionId,
        manifests: next.manifests,
      },
      recovery: {
        selectionBefore: before,
        touchedServiceIds: touched,
        previouslyEnabledServiceIds: enabled,
      },
    };
  }
  return { version: COMMUNITY_RECORD_VERSION, repository, ...source, pending };
}

/**
 * Reads the record of `repository` from `communityDir`, or returns `null` when
 * there is none. The record must be a regular file with one link, owned by
 * `uid`, that neither its group nor others can write, and of at most 256 KiB.
 */
export function readCommunityRepositoryRecord(
  communityDir: string,
  repository: string,
  uid: number = process.geteuid?.() ?? 0,
): CommunityRepositoryRecord | null {
  const path = join(communityDir, communityRecordFileName(repository));
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Repository record ${repository} is invalid`);
  }
  try {
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== uid ||
      (metadata.mode & 0o022) !== 0 ||
      metadata.size < 2 ||
      metadata.size > MAX_RECORD_BYTES
    ) {
      throw new Error(`Repository record ${repository} is invalid`);
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error(`Repository record ${repository} is invalid`);
      offset += read;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error(`Repository record ${repository} is invalid`);
    }
    return parseCommunityRepositoryRecord(raw, repository);
  } finally {
    closeSync(fd);
  }
}

/** One recorded service, read and verified from a repository checkout. */
export interface VerifiedCommunityService {
  service: LoadedService;
  bytes: Uint8Array;
}

function isRealDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The services of `checkout` exactly as `manifests` records them, or `null`
 * when any recorded manifest is missing, reached through a symbolic link,
 * has different bytes or no longer passes the community manifest rules.
 */
function verifyCheckout(
  checkout: string,
  manifests: readonly RecordedManifest[],
): VerifiedCommunityService[] | null {
  if (!isRealDirectory(checkout)) return null;
  const verified: VerifiedCommunityService[] = [];
  for (const { path, sha256 } of manifests) {
    let directory = checkout;
    for (const segment of path === "" ? [] : path.split("/")) {
      directory = join(directory, segment);
      if (!isRealDirectory(directory)) return null;
    }
    let bytes: Buffer;
    try {
      bytes = readRegularFileBytes(join(directory, "service.json"), MAX_MANIFEST_BYTES);
    } catch {
      return null;
    }
    if (manifestSha256(bytes) !== sha256) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return null;
    }
    if (communityServiceManifestProblems(raw).length > 0) return null;
    verified.push({
      service: {
        manifest: raw as ServiceManifest,
        directory: resolve(directory),
        isBuiltIn: false,
        enabled: true,
      },
      bytes,
    });
  }
  return verified;
}

/**
 * The services a repository's checkout holds, verified against its record.
 * A transaction in progress may leave the checkout at either side of it, or
 * briefly absent; outside one, the checkout must hold exactly the recorded
 * commit. Throws when the checkout matches no recorded state.
 */
export function verifyRecordedRepository(
  checkout: string,
  record: CommunityRepositoryRecord,
): VerifiedCommunityService[] {
  const candidates: Array<readonly RecordedManifest[] | null> = [record.manifests];
  if (record.pending) candidates.push(record.pending.next.manifests, null);
  const present = isRealDirectory(checkout);
  for (const candidate of candidates) {
    if (candidate === null) {
      if (!present) return [];
      continue;
    }
    if (!present) continue;
    const verified = verifyCheckout(checkout, candidate);
    if (verified) return verified;
  }
  throw new Error(FAILED);
}

export interface LoadRecordedCommunityServicesOptions {
  /** Owner every record must have. Defaults to the effective uid. */
  uid?: number;
}

/**
 * Every community service the operations agent recorded under
 * `<rootDir>/services/.community`, verified against its digest. Repository
 * directories without a record are ignored. Throws when a record is invalid,
 * a checkout matches none of its recorded states, or the services exceed the
 * agent's limits.
 */
export function loadRecordedCommunityServices(
  rootDir: string,
  options: LoadRecordedCommunityServicesOptions = {},
): VerifiedCommunityService[] {
  const community = join(resolve(rootDir), "services", ".community");
  let names: string[];
  try {
    names = readdirSync(community);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CommunityServiceRecordsError();
  }
  try {
    const repositories = names
      .map(communityRecordRepository)
      .filter((repository): repository is string => repository !== null)
      .sort();
    if (repositories.length > MAX_REPOSITORIES) throw new CommunityServiceRecordsError();
    const services: VerifiedCommunityService[] = [];
    const ids = new Set<string>();
    let totalBytes = 0;
    for (const repository of repositories) {
      let record: CommunityRepositoryRecord | null;
      try {
        record = readCommunityRepositoryRecord(community, repository, options.uid);
      } catch {
        throw new CommunityServiceRecordsError(
          `The record of community repository ${repository} is not one the operations agent wrote. ${recovery(repository)}`,
        );
      }
      if (!record) continue;
      let verified: VerifiedCommunityService[];
      try {
        verified = verifyRecordedRepository(join(community, repository), record);
      } catch {
        throw new CommunityServiceRecordsError(
          `Community repository ${repository} no longer matches the service manifests the operations agent recorded when it installed it. ${recovery(repository)}`,
        );
      }
      for (const entry of verified) {
        if (ids.has(entry.service.manifest.id)) throw new CommunityServiceRecordsError();
        ids.add(entry.service.manifest.id);
        totalBytes += entry.bytes.byteLength;
        services.push(entry);
      }
      if (services.length > MAX_MANIFESTS || totalBytes > MAX_TOTAL_MANIFEST_BYTES) {
        throw new CommunityServiceRecordsError();
      }
    }
    return services;
  } catch (error) {
    if (error instanceof CommunityServiceRecordsError) throw error;
    throw new CommunityServiceRecordsError();
  }
}
