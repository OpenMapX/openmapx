import { randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_PLATFORM_SECRET_BYTES = 4_096;
let temporarySequence = 0;

export interface EnsurePlatformSecretOptions {
  randomBytes?: (size: number) => Uint8Array;
  temporaryFileOps?: PlatformTemporaryFileOps;
  publicationHooks?: PlatformSecretPublicationHooks;
  replacementHooks?: PlatformReplacementHooks;
}

export interface PlatformSecretPublicationHooks {
  beforeRetry?: (attempt: number) => void;
  retryWait?: (attempt: number) => void;
}

export interface PlatformReplacementHooks {
  afterRename?: () => void;
}

export interface PlatformTemporaryFileOps {
  write?: (fd: number, contents: string) => void;
  fsync?: (fd: number) => void;
  chmod?: (fd: number, mode: number) => void;
  unlink?: (path: string) => void;
}

export interface PlatformSecretMetadata {
  uid: number;
  nlink: number;
}

export interface PlatformPrivateDirectoryMetadata {
  uid: number;
  gid: number;
  mode: number;
}

export type PlatformTargetMetadataValidator = (
  file: PlatformSecretMetadata,
  parent: Pick<PlatformSecretMetadata, "uid">,
) => void;

export interface PreparePlatformFileOptions {
  temporaryFileOps?: PlatformTemporaryFileOps;
  targetMetadataValidator?: PlatformTargetMetadataValidator;
  requireExisting?: boolean;
  replacementHooks?: PlatformReplacementHooks;
}

export interface PreparedPlatformFileReplacement {
  assertTargetUnchanged: () => void;
  cleanup: () => void;
  commit: () => void;
  readonly hasCommitted: () => boolean;
}

export interface PreparedPlatformSecretReplacement extends PreparedPlatformFileReplacement {
  value: string;
}

export class PlatformFileTargetChangedError extends Error {
  constructor() {
    super("Platform file target changed during atomic replacement");
    this.name = "PlatformFileTargetChangedError";
  }
}

class PlatformSecretLinkCountError extends Error {
  constructor() {
    super("Platform secret must have exactly one link");
    this.name = "PlatformSecretLinkCountError";
  }
}

export function assertPlatformSecretParentOwner(
  parent: Pick<PlatformSecretMetadata, "uid">,
  effectiveUid: number | undefined,
): void {
  if (effectiveUid === undefined || parent.uid !== effectiveUid) {
    throw new Error("Platform secret parent must be owned by the invoking user");
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function assertPlatformSecretMetadata(
  file: PlatformSecretMetadata,
  parent: Pick<PlatformSecretMetadata, "uid">,
): void {
  if (file.nlink !== 1) {
    throw new PlatformSecretLinkCountError();
  }
  if (file.uid !== parent.uid) {
    throw new Error("Platform secret and protected parent must have the same owner");
  }
}

function ensureSecureParent(path: string): Stats {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  let stats = lstatSync(parent);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Platform secret parent must be a regular directory");
  }
  assertPlatformSecretParentOwner(stats, process.geteuid?.());
  chmodSync(parent, 0o700);
  stats = lstatSync(parent);
  if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o777) !== 0o700) {
    throw new Error("Platform secret parent must be a protected 0700 directory");
  }
  assertPlatformSecretParentOwner(stats, process.geteuid?.());
  return stats;
}

/**
 * Prepares a confidential host-owned handoff directory before Compose starts.
 * Both the API (currently root) and ops-agent (`${UID}:${GID}`) use this exact
 * host uid/gid boundary, so startup never depends on a root-owned named volume
 * being initialized by either container.
 */
export function ensurePlatformPrivateDirectory(path: string): PlatformPrivateDirectoryMetadata {
  const uid = process.geteuid?.();
  const gid = process.getegid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Platform private directory ownership is unavailable");
  }
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    let stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== uid || stats.gid !== gid) {
      throw new Error();
    }
    chmodSync(path, 0o700);
    stats = lstatSync(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.uid !== uid ||
      stats.gid !== gid ||
      (stats.mode & 0o777) !== 0o700
    ) {
      throw new Error();
    }
    const directoryFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
    return { uid, gid, mode: 0o700 };
  } catch {
    throw new Error("Platform private directory is unsafe");
  }
}

function isCanonicalPlatformSecret(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function readExistingSecret(path: string, parentStats: Stats): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error("Platform secret must be a regular file");
    throw new Error("Platform secret is unreadable");
  }

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("Platform secret must be a regular file");
    assertPlatformSecretMetadata(stats, parentStats);
    if (stats.size > MAX_PLATFORM_SECRET_BYTES) {
      throw new Error("Platform secret exceeds the size limit");
    }
    const bytes = Buffer.alloc(MAX_PLATFORM_SECRET_BYTES + 1);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_PLATFORM_SECRET_BYTES) {
      throw new Error("Platform secret exceeds the size limit");
    }
    if (bytesRead === 0) throw new Error("Platform secret file is empty");
    const value = bytes.subarray(0, bytesRead).toString("utf8");
    if (!isCanonicalPlatformSecret(value)) {
      throw new Error("Platform secret file is not canonical base64url-encoded 32-byte data");
    }
    // Docker Compose mounts source-file permissions unchanged. The 0700
    // parent is the host boundary; 0444 lets non-root container users read the
    // individual bind-mounted file, matching the existing Compose-secret model.
    fchmodSync(fd, 0o444);
    return value;
  } finally {
    closeSync(fd);
  }
}

export function readPlatformSecretFile(path: string): string {
  const value = readExistingSecret(path, ensureSecureParent(path));
  if (value === null) throw new Error("Platform secret is missing");
  return value;
}

function resolveTemporaryFileOps(overrides: PlatformTemporaryFileOps = {}) {
  return {
    write:
      overrides.write ?? ((fd: number, contents: string) => writeFileSync(fd, contents, "utf8")),
    fsync: overrides.fsync ?? fsyncSync,
    chmod: overrides.chmod ?? fchmodSync,
    unlink: overrides.unlink ?? unlinkSync,
  };
}

function createTemporaryFile(
  path: string,
  contents: string,
  overrides: PlatformTemporaryFileOps = {},
): string {
  const parent = dirname(path);
  const ops = resolveTemporaryFileOps(overrides);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    temporarySequence += 1;
    const temporary = join(parent, `.${basename(path)}.${process.pid}.${temporarySequence}.tmp`);
    let fd: number;
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o400,
      );
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
    let failure: unknown;
    try {
      ops.write(fd, contents);
      ops.chmod(fd, 0o444);
      // Sync after the final chmod so both data and candidate metadata are
      // durable before any publication or authoritative rename.
      ops.fsync(fd);
    } catch (error) {
      failure = error;
    }
    try {
      closeSync(fd);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) {
      try {
        ops.unlink(temporary);
      } catch {
        // Cleanup is best effort, but the original write-stage error remains
        // authoritative and must never be masked by a secondary unlink error.
      }
      throw failure;
    }
    return temporary;
  }
  throw new Error("Unable to allocate an atomic platform secret temporary file");
}

function cleanupTemporaryFile(path: string, overrides: PlatformTemporaryFileOps = {}): void {
  const unlink = overrides.unlink ?? unlinkSync;
  try {
    unlink(path);
  } catch {
    // Best effort after an atomic operation. A subsequent call uses a fresh
    // exclusive name and never treats a stale temporary file as authoritative.
  }
}

function unlinkAuthoritativeTemporary(
  path: string,
  overrides: PlatformTemporaryFileOps = {},
): void {
  const unlink = overrides.unlink ?? unlinkSync;
  try {
    unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function generatePlatformSecret(options: EnsurePlatformSecretOptions): string {
  const source = options.randomBytes ?? cryptoRandomBytes;
  const generated = Buffer.from(source(32));
  if (generated.length !== 32) {
    throw new Error("Platform secret randomness source returned an invalid byte count");
  }
  return generated.toString("base64url");
}

interface PlatformFileSnapshot extends PlatformSecretMetadata {
  dev: number;
  ino: number;
}

function readPlatformFileSnapshot(
  path: string,
  parentStats: Stats,
  validator: PlatformTargetMetadataValidator = assertPlatformSecretMetadata,
): PlatformFileSnapshot | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) === "ELOOP") {
      throw new Error("Platform file target must be a regular file");
    }
    throw new Error("Platform file target is unreadable");
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("Platform file target must be a regular file");
    validator(stats, parentStats);
    return { dev: stats.dev, ino: stats.ino, uid: stats.uid, nlink: stats.nlink };
  } finally {
    closeSync(fd);
  }
}

export function assertPlatformFileTarget(
  path: string,
  options: Pick<PreparePlatformFileOptions, "targetMetadataValidator" | "requireExisting"> = {},
): void {
  const snapshot = readPlatformFileSnapshot(
    path,
    ensureSecureParent(path),
    options.targetMetadataValidator,
  );
  if (options.requireExisting && snapshot === null) {
    throw new Error("Platform file target must already exist");
  }
}

export function readPlatformFileContents(
  path: string,
  maxBytes = MAX_PLATFORM_SECRET_BYTES,
): string {
  const parentStats = ensureSecureParent(path);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ELOOP")
      throw new Error("Platform file target must be a regular file");
    throw new Error("Platform file target is missing or unreadable");
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("Platform file target must be a regular file");
    assertPlatformSecretMetadata(stats, parentStats);
    if (stats.size > maxBytes) throw new Error("Platform file target exceeds the size limit");
    const bytes = Buffer.alloc(maxBytes + 1);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error("Platform file target exceeds the size limit");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function sameSnapshot(
  left: PlatformFileSnapshot | null,
  right: PlatformFileSnapshot | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink
  );
}

function defaultPublicationRetryWait(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

function readPublicationWinner(
  path: string,
  parentStats: Stats,
  hooks: PlatformSecretPublicationHooks = {},
): string {
  const maxAttempts = 25;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const winner = readExistingSecret(path, parentStats);
      if (winner === null) throw new Error("Platform secret race winner disappeared");
      return winner;
    } catch (error) {
      if (!(error instanceof PlatformSecretLinkCountError) || attempt === maxAttempts - 1) {
        throw error;
      }
      hooks.beforeRetry?.(attempt);
      (hooks.retryWait ?? defaultPublicationRetryWait)(attempt);
    }
  }
  throw new Error("Platform secret race winner did not finish publication");
}

export function ensurePlatformSecretFile(
  path: string,
  options: EnsurePlatformSecretOptions = {},
): string {
  const parentStats = ensureSecureParent(path);
  const existing = readExistingSecret(path, parentStats);
  if (existing !== null) return existing;

  const value = generatePlatformSecret(options);
  const temporary = createTemporaryFile(path, value, options.temporaryFileOps);
  try {
    // A hard link is an atomic create-without-replace operation. If another
    // renderer won the race, EEXIST preserves its value and we reuse it.
    linkSync(temporary, path);
    unlinkAuthoritativeTemporary(temporary, options.temporaryFileOps);
    const authoritative = readExistingSecret(path, parentStats);
    if (authoritative === null) throw new Error("Platform secret disappeared after creation");
    return authoritative;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      // A loser must prove its own unpublished candidate is gone before it may
      // reuse the winner. Otherwise stale secret material accumulates while the
      // operation incorrectly reports success.
      unlinkAuthoritativeTemporary(temporary, options.temporaryFileOps);
      return readPublicationWinner(path, parentStats, options.publicationHooks);
    }
    cleanupTemporaryFile(temporary, options.temporaryFileOps);
    throw error;
  }
}

export function preparePlatformFileReplacement(
  path: string,
  contents: string,
  options: PreparePlatformFileOptions = {},
): PreparedPlatformFileReplacement {
  const parentStats = ensureSecureParent(path);
  const validator = options.targetMetadataValidator ?? assertPlatformSecretMetadata;
  const targetSnapshot = readPlatformFileSnapshot(path, parentStats, validator);
  if (options.requireExisting && targetSnapshot === null) {
    throw new Error("Platform file target must already exist");
  }
  const temporary = createTemporaryFile(path, contents, options.temporaryFileOps);
  let candidateSnapshot: PlatformFileSnapshot | null;
  try {
    candidateSnapshot = readPlatformFileSnapshot(temporary, parentStats, validator);
  } catch (error) {
    cleanupTemporaryFile(temporary, options.temporaryFileOps);
    throw error;
  }
  if (candidateSnapshot === null) {
    cleanupTemporaryFile(temporary, options.temporaryFileOps);
    throw new Error("Platform file candidate disappeared before commit");
  }
  let committed = false;

  const assertTargetUnchanged = () => {
    const current = readPlatformFileSnapshot(path, parentStats, validator);
    if (!sameSnapshot(targetSnapshot, current)) throw new PlatformFileTargetChangedError();
  };
  const cleanup = () => {
    if (!committed) cleanupTemporaryFile(temporary, options.temporaryFileOps);
  };
  const commit = () => {
    assertTargetUnchanged();
    try {
      renameSync(temporary, path);
    } catch (error) {
      cleanup();
      throw error;
    }
    committed = true;
    options.replacementHooks?.afterRename?.();
    const authoritative = readPlatformFileSnapshot(path, parentStats, validator);
    if (!sameSnapshot(candidateSnapshot, authoritative)) {
      throw new Error("Platform file candidate was not installed authoritatively");
    }
  };
  const hasCommitted = () => committed;
  return { assertTargetUnchanged, cleanup, commit, hasCommitted };
}

export function preparePlatformSecretReplacement(
  path: string,
  options: EnsurePlatformSecretOptions = {},
): PreparedPlatformSecretReplacement {
  readPlatformSecretFile(path);
  const value = generatePlatformSecret(options);
  const replacement = preparePlatformFileReplacement(path, value, {
    temporaryFileOps: options.temporaryFileOps,
    requireExisting: true,
    replacementHooks: options.replacementHooks,
  });
  try {
    // Bind the metadata snapshot to a still-canonical authoritative password.
    readPlatformSecretFile(path);
    replacement.assertTargetUnchanged();
  } catch (error) {
    replacement.cleanup();
    throw error;
  }
  return { ...replacement, value };
}

export function rotatePlatformSecretFile(
  path: string,
  options: EnsurePlatformSecretOptions = {},
): string {
  let replacement: PreparedPlatformSecretReplacement;
  try {
    replacement = preparePlatformSecretReplacement(path, options);
  } catch (error) {
    if ((error as Error).message === "Platform secret is missing") {
      throw new Error("Redis rotation requires an existing platform secret");
    }
    throw error;
  }
  replacement.commit();
  return readPlatformSecretFile(path);
}

export function writePlatformFileAtomically(
  path: string,
  contents: string,
  temporaryFileOps: PlatformTemporaryFileOps = {},
): void {
  preparePlatformFileReplacement(path, contents, { temporaryFileOps }).commit();
}
