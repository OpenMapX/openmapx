import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME = ".trusted-config-queue.lock";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const OWNER_NAME = "owner.json";
const HEARTBEAT_NAME = "heartbeat.json";
const MIN_TTL_MS = 50;
const DEFAULT_TTL_MS = 5_000;
const MAX_TTL_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 7_000;
const MAX_ACQUIRE_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_MS = 25;
const MAX_ARTIFACTS = 16;
const MAX_ARTIFACT_SCAN_WORK = 256;
const MAX_RECORD_BYTES = 2_048;
const FAILED = "Trusted configuration queue busy";
const ARTIFACT_GUIDANCE = "Trusted configuration queue artifacts require operator cleanup";
const OWNER_MAC_DOMAIN = "openmapx-trusted-config-queue-lock-owner-mac-v2\0";
const HEARTBEAT_MAC_DOMAIN = "openmapx-trusted-config-queue-lock-heartbeat-mac-v2\0";
const RETIREMENT_MAC_DOMAIN = "openmapx-trusted-config-queue-lock-retirement-mac-v2\0";
const PUBLICATION_MAC_DOMAIN = "openmapx-trusted-config-queue-lock-publication-mac-v2\0";
const CONTENT_DOMAIN = "openmapx-trusted-config-queue-lock-content-v2\0";
const PROCESS_INSTANCE = randomUUID().replaceAll("-", "");
const PROCESS_STARTED_AT_MS = Date.now();
/**
 * A second acquisition in this process must not reclaim a holder whose timer
 * callback was delayed by the event loop. The authenticated on-disk heartbeat
 * remains the cross-process authority; this set only closes the same-process
 * scheduling race until the holder releases, abandons, or loses its lease.
 */
const ACTIVE_PROCESS_GENERATIONS = new Set<string>();
const ARTIFACT = /^\.trusted-config-queue\.lock\.(tmp|recovery)\.([a-f0-9]{32})$/;
const PUBLICATION = /^\.trusted-config-queue\.lock\.publication\.([a-f0-9]{32})$/;
const RETIREMENT = /^\.trusted-config-queue\.lock\.retirement\.([a-f0-9]{32})$/;
const RENEWAL = /^\.heartbeat\.(\d{1,16})\.([a-f0-9]{32})\.tmp$/;

interface UnsignedOwner {
  version: 2;
  participant: "api" | "ops-agent";
  operationKey: string;
  processInstance: string;
  processStartedAtMs: number;
  pid: number;
  generation: string;
  nonce: string;
  directoryDev: number;
  directoryIno: number;
  ttlMs: number;
}

interface OwnerRecord extends UnsignedOwner {
  mac: string;
}

interface UnsignedHeartbeat {
  version: 2;
  generation: string;
  nonce: string;
  sequence: number;
  issuedAtMs: number;
  expiresAtMs: number;
}

interface HeartbeatRecord extends UnsignedHeartbeat {
  mac: string;
}

interface UnsignedRetirement {
  version: 2;
  generation: string;
  nonce: string;
  directoryDev: number;
  directoryIno: number;
  ownerDigest: string;
  heartbeatDigest: string;
}

interface RetirementRecord extends UnsignedRetirement {
  mac: string;
}

interface UnsignedPublication {
  version: 2;
  participant: "api" | "ops-agent";
  operationKey: string;
  processInstance: string;
  processStartedAtMs: number;
  pid: number;
  generation: string;
  nonce: string;
  directoryDev: number;
  directoryIno: number;
  rootDev: number;
  rootIno: number;
  issuedAtMs: number;
  expiresAtMs: number;
}

interface PublicationRecord extends UnsignedPublication {
  mac: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  bytes: Buffer;
}

interface InspectedGeneration {
  directory: { dev: number; ino: number };
  owner: OwnerRecord;
  ownerIdentity: FileIdentity;
  heartbeat: HeartbeatRecord;
  heartbeatIdentity: FileIdentity;
  renewal?: {
    name: string;
    heartbeat: HeartbeatRecord;
    identity: FileIdentity;
  };
}

export interface TrustedConfigurationQueueLockOptions {
  directory: string;
  token: string;
  ownerUid: number;
  ownerGid: number;
  participant: "api" | "ops-agent";
  operationKey: string;
  ttlMs?: number;
  acquireTimeoutMs?: number;
  retryMs?: number;
  afterHeartbeatRecordWrite?: () => void;
  afterRecoveryHeartbeatUnlink?: () => void;
  afterRecoveryOwnerUnlink?: () => void;
  afterRecoveryRetirementUnlink?: () => void;
  afterPublicationIntentWrite?: () => void;
  beforeLockDirectoryCreate?: () => void;
  afterStableLockDirectoryCreate?: () => void;
  afterOwnerRecordWrite?: () => void;
  afterInitialHeartbeatRecordWrite?: () => void;
  afterStableLockDirectorySync?: () => void;
  afterPublicationCommit?: () => void;
}

export interface TrustedConfigurationQueueLock {
  assertHeld(): void;
  release(): void;
  /** Stops renewal without mutating the generation; used to model abrupt death. */
  abandon(): void;
}

function fail(): never {
  throw new Error(FAILED);
}

class ArtifactGuidanceError extends Error {
  constructor() {
    super(ARTIFACT_GUIDANCE);
  }
}

function artifactGuidance(): never {
  throw new ArtifactGuidanceError();
}

function tokenKey(token: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail();
  const decoded = Buffer.from(token, "base64url");
  if (decoded.byteLength !== 32) fail();
  return decoded;
}

function ownerMac(owner: UnsignedOwner, token: string): string {
  return createHmac("sha256", tokenKey(token))
    .update(OWNER_MAC_DOMAIN)
    .update(JSON.stringify(owner))
    .digest("base64url");
}

function heartbeatMac(heartbeat: UnsignedHeartbeat, token: string): string {
  return createHmac("sha256", tokenKey(token))
    .update(HEARTBEAT_MAC_DOMAIN)
    .update(JSON.stringify(heartbeat))
    .digest("base64url");
}

function retirementMac(retirement: UnsignedRetirement, token: string): string {
  return createHmac("sha256", tokenKey(token))
    .update(RETIREMENT_MAC_DOMAIN)
    .update(JSON.stringify(retirement))
    .digest("base64url");
}

function publicationMac(publication: UnsignedPublication, token: string): string {
  return createHmac("sha256", tokenKey(token))
    .update(PUBLICATION_MAC_DOMAIN)
    .update(JSON.stringify(publication))
    .digest("base64url");
}

function digest(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(CONTENT_DOMAIN).update(bytes).digest();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validateDirectory(
  path: string,
  ownerUid: number,
  ownerGid: number,
  expected?: { dev: number; ino: number },
): { dev: number; ino: number } {
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
      opened.uid !== ownerUid ||
      opened.gid !== ownerGid ||
      (opened.mode & 0o777) !== DIRECTORY_MODE ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino))
    )
      fail();
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    closeSync(fd);
  }
}

function readExactFile(path: string, ownerUid: number, ownerGid: number): FileIdentity {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.uid !== ownerUid ||
      opened.gid !== ownerGid ||
      (opened.mode & 0o777) !== FILE_MODE ||
      opened.size < 2 ||
      opened.size > MAX_RECORD_BYTES ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      fail();
    return { dev: opened.dev, ino: opened.ino, bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

function authenticatedOwner(bytes: Buffer, token: string): OwnerRecord {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "directoryDev,directoryIno,generation,mac,nonce,operationKey,participant,pid,processInstance,processStartedAtMs,ttlMs,version" ||
    record.version !== 2 ||
    !["api", "ops-agent"].includes(record.participant as string) ||
    typeof record.operationKey !== "string" ||
    !/^(?:opk1_[A-Za-z0-9_-]{16,64}|startup)$/.test(record.operationKey) ||
    typeof record.processInstance !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.processInstance) ||
    !Number.isSafeInteger(record.processStartedAtMs) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) < 1 ||
    typeof record.generation !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.generation) ||
    typeof record.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.nonce) ||
    !Number.isSafeInteger(record.directoryDev) ||
    !Number.isSafeInteger(record.directoryIno) ||
    !Number.isSafeInteger(record.ttlMs) ||
    (record.ttlMs as number) < MIN_TTL_MS ||
    (record.ttlMs as number) > MAX_TTL_MS ||
    typeof record.mac !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.mac)
  )
    fail();
  const owner = record as unknown as OwnerRecord;
  const { mac, ...unsigned } = owner;
  const expected = Buffer.from(ownerMac(unsigned, token), "base64url");
  const actual = Buffer.from(mac, "base64url");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) fail();
  return owner;
}

function authenticatedHeartbeat(bytes: Buffer, token: string): HeartbeatRecord {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "expiresAtMs,generation,issuedAtMs,mac,nonce,sequence,version" ||
    record.version !== 2 ||
    typeof record.generation !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.generation) ||
    typeof record.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.nonce) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    !Number.isSafeInteger(record.issuedAtMs) ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    (record.expiresAtMs as number) <= (record.issuedAtMs as number) ||
    (record.expiresAtMs as number) - (record.issuedAtMs as number) > MAX_TTL_MS ||
    typeof record.mac !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.mac)
  )
    fail();
  const heartbeat = record as unknown as HeartbeatRecord;
  const { mac, ...unsigned } = heartbeat;
  const expected = Buffer.from(heartbeatMac(unsigned, token), "base64url");
  const actual = Buffer.from(mac, "base64url");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) fail();
  return heartbeat;
}

function authenticatedRetirement(bytes: Buffer, token: string): RetirementRecord {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "directoryDev,directoryIno,generation,heartbeatDigest,mac,nonce,ownerDigest,version" ||
    record.version !== 2 ||
    typeof record.generation !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.generation) ||
    typeof record.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.nonce) ||
    !Number.isSafeInteger(record.directoryDev) ||
    !Number.isSafeInteger(record.directoryIno) ||
    typeof record.ownerDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.ownerDigest) ||
    typeof record.heartbeatDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.heartbeatDigest) ||
    typeof record.mac !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.mac)
  )
    fail();
  const retirement = record as unknown as RetirementRecord;
  const { mac, ...unsigned } = retirement;
  const expected = Buffer.from(retirementMac(unsigned, token), "base64url");
  const actual = Buffer.from(mac, "base64url");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) fail();
  return retirement;
}

function authenticatedPublication(bytes: Buffer, token: string): PublicationRecord {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) artifactGuidance();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "directoryDev,directoryIno,expiresAtMs,generation,issuedAtMs,mac,nonce,operationKey,participant,pid,processInstance,processStartedAtMs,rootDev,rootIno,version" ||
    record.version !== 2 ||
    !["api", "ops-agent"].includes(record.participant as string) ||
    typeof record.operationKey !== "string" ||
    !/^(?:opk1_[A-Za-z0-9_-]{16,64}|startup)$/.test(record.operationKey) ||
    typeof record.processInstance !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.processInstance) ||
    !Number.isSafeInteger(record.processStartedAtMs) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) < 1 ||
    typeof record.generation !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.generation) ||
    typeof record.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.nonce) ||
    !Number.isSafeInteger(record.directoryDev) ||
    !Number.isSafeInteger(record.directoryIno) ||
    !Number.isSafeInteger(record.rootDev) ||
    !Number.isSafeInteger(record.rootIno) ||
    !Number.isSafeInteger(record.issuedAtMs) ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    (record.expiresAtMs as number) <= (record.issuedAtMs as number) ||
    (record.expiresAtMs as number) - (record.issuedAtMs as number) > MAX_TTL_MS ||
    typeof record.mac !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.mac)
  )
    artifactGuidance();
  const publication = record as unknown as PublicationRecord;
  const { mac, ...unsigned } = publication;
  const expected = Buffer.from(publicationMac(unsigned, token), "base64url");
  const actual = Buffer.from(mac, "base64url");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    artifactGuidance();
  }
  return publication;
}

function contentDigest(bytes: Uint8Array): string {
  return digest(bytes).toString("base64url");
}

function inspectGeneration(
  path: string,
  options: TrustedConfigurationQueueLockOptions,
  expectedDirectory?: { dev: number; ino: number },
): InspectedGeneration {
  const directory = validateDirectory(path, options.ownerUid, options.ownerGid, expectedDirectory);
  const names = readdirSync(path).sort();
  const renewalNames = names.filter((name) => RENEWAL.test(name));
  if (
    !names.includes(HEARTBEAT_NAME) ||
    !names.includes(OWNER_NAME) ||
    renewalNames.length > 1 ||
    names.length !== 2 + renewalNames.length
  )
    fail();
  const ownerIdentity = readExactFile(join(path, OWNER_NAME), options.ownerUid, options.ownerGid);
  const heartbeatIdentity = readExactFile(
    join(path, HEARTBEAT_NAME),
    options.ownerUid,
    options.ownerGid,
  );
  const owner = authenticatedOwner(ownerIdentity.bytes, options.token);
  const heartbeat = authenticatedHeartbeat(heartbeatIdentity.bytes, options.token);
  if (
    owner.directoryDev !== directory.dev ||
    owner.directoryIno !== directory.ino ||
    heartbeat.generation !== owner.generation ||
    heartbeat.nonce !== owner.nonce
  )
    fail();
  let renewal: InspectedGeneration["renewal"];
  if (renewalNames[0]) {
    const match = RENEWAL.exec(renewalNames[0]);
    if (!match || match[2] !== owner.nonce) fail();
    const identity = readExactFile(join(path, renewalNames[0]), options.ownerUid, options.ownerGid);
    const renewalHeartbeat = authenticatedHeartbeat(identity.bytes, options.token);
    if (
      renewalHeartbeat.generation !== owner.generation ||
      renewalHeartbeat.nonce !== owner.nonce ||
      renewalHeartbeat.sequence !== heartbeat.sequence + 1 ||
      renewalHeartbeat.sequence !== Number(match[1])
    )
      fail();
    renewal = { name: renewalNames[0], heartbeat: renewalHeartbeat, identity };
  }
  return { directory, owner, ownerIdentity, heartbeat, heartbeatIdentity, renewal };
}

function removeGeneration(
  path: string,
  options: TrustedConfigurationQueueLockOptions,
  inspected: InspectedGeneration,
): void {
  const current = inspectGeneration(path, options, inspected.directory);
  if (
    current.renewal ||
    current.ownerIdentity.dev !== inspected.ownerIdentity.dev ||
    current.ownerIdentity.ino !== inspected.ownerIdentity.ino ||
    current.heartbeatIdentity.dev !== inspected.heartbeatIdentity.dev ||
    current.heartbeatIdentity.ino !== inspected.heartbeatIdentity.ino ||
    !equalBytes(current.ownerIdentity.bytes, inspected.ownerIdentity.bytes) ||
    !equalBytes(current.heartbeatIdentity.bytes, inspected.heartbeatIdentity.bytes)
  )
    fail();
  const unsignedRetirement: UnsignedRetirement = {
    version: 2,
    generation: current.owner.generation,
    nonce: current.owner.nonce,
    directoryDev: current.directory.dev,
    directoryIno: current.directory.ino,
    ownerDigest: contentDigest(current.ownerIdentity.bytes),
    heartbeatDigest: contentDigest(current.heartbeatIdentity.bytes),
  };
  const retirementPath = join(
    options.directory,
    `${OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME}.retirement.${current.owner.generation}`,
  );
  const retirementIdentity = writeRecord(
    retirementPath,
    Buffer.from(
      `${JSON.stringify({ ...unsignedRetirement, mac: retirementMac(unsignedRetirement, options.token) })}\n`,
    ),
    options.ownerUid,
    options.ownerGid,
  );
  syncDirectory(options.directory);
  removeExactFile(
    join(path, HEARTBEAT_NAME),
    current.heartbeatIdentity,
    options.ownerUid,
    options.ownerGid,
  );
  syncDirectory(path);
  options.afterRecoveryHeartbeatUnlink?.();
  removeExactFile(
    join(path, OWNER_NAME),
    current.ownerIdentity,
    options.ownerUid,
    options.ownerGid,
  );
  syncDirectory(path);
  options.afterRecoveryOwnerUnlink?.();
  validateDirectory(path, options.ownerUid, options.ownerGid, current.directory);
  if (readdirSync(path).length !== 0) fail();
  rmdirSync(path);
  syncDirectory(options.directory);
  removeExactFile(retirementPath, retirementIdentity, options.ownerUid, options.ownerGid);
  options.afterRecoveryRetirementUnlink?.();
  syncDirectory(options.directory);
}

function writeRecord(
  path: string,
  bytes: Buffer,
  ownerUid: number,
  ownerGid: number,
): FileIdentity {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  const created = fstatSync(fd);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, FILE_MODE);
    fchownSync(fd, ownerUid, ownerGid);
    fsyncSync(fd);
    const stats = fstatSync(fd);
    return { dev: stats.dev, ino: stats.ino, bytes };
  } catch (error) {
    try {
      const current = lstatSync(path);
      if (current.dev === created.dev && current.ino === created.ino) unlinkSync(path);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

function removeExactFile(
  path: string,
  expected: FileIdentity,
  ownerUid: number,
  ownerGid: number,
): void {
  const current = readExactFile(path, ownerUid, ownerGid);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    !equalBytes(current.bytes, expected.bytes)
  )
    fail();
  unlinkSync(path);
}

class SimulatedPublicationCrash extends Error {}

function runPublicationHook(hook: (() => void) | undefined): void {
  if (!hook) return;
  try {
    hook();
  } catch {
    throw new SimulatedPublicationCrash();
  }
}

function heartbeatBytes(
  owner: OwnerRecord,
  sequence: number,
  nowMs: number,
  token: string,
): Buffer {
  const unsigned: UnsignedHeartbeat = {
    version: 2,
    generation: owner.generation,
    nonce: owner.nonce,
    sequence,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + owner.ttlMs,
  };
  return Buffer.from(`${JSON.stringify({ ...unsigned, mac: heartbeatMac(unsigned, token) })}\n`);
}

function publishGeneration(options: TrustedConfigurationQueueLockOptions, ttlMs: number): void {
  const lockPath = join(options.directory, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
  const root = validateDirectory(options.directory, options.ownerUid, options.ownerGid);
  const generation = randomUUID().replaceAll("-", "");
  const nonce = randomUUID().replaceAll("-", "");
  const publicationPath = join(
    options.directory,
    `${OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME}.publication.${generation}`,
  );
  const createdFiles = new Map<string, FileIdentity>();
  let publicationIdentity: FileIdentity | undefined;
  let createdLockIdentity: { dev: number; ino: number } | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  let published = false;
  let simulatedCrash = false;
  try {
    const issuedAtMs = Date.now();
    runPublicationHook(options.beforeLockDirectoryCreate);
    mkdirSync(lockPath, { mode: DIRECTORY_MODE });
    const createdLock = lstatSync(lockPath);
    if (!createdLock.isDirectory() || createdLock.isSymbolicLink()) fail();
    createdLockIdentity = { dev: createdLock.dev, ino: createdLock.ino };
    chmodSync(lockPath, DIRECTORY_MODE);
    chownSync(lockPath, options.ownerUid, options.ownerGid);
    lockIdentity = validateDirectory(lockPath, options.ownerUid, options.ownerGid);
    runPublicationHook(options.afterStableLockDirectoryCreate);
    const unsignedPublication: UnsignedPublication = {
      version: 2,
      participant: options.participant,
      operationKey: options.operationKey,
      processInstance: PROCESS_INSTANCE,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      pid: process.pid,
      generation,
      nonce,
      directoryDev: lockIdentity.dev,
      directoryIno: lockIdentity.ino,
      rootDev: root.dev,
      rootIno: root.ino,
      issuedAtMs,
      expiresAtMs: issuedAtMs + ttlMs,
    };
    publicationIdentity = writeRecord(
      publicationPath,
      Buffer.from(
        `${JSON.stringify({ ...unsignedPublication, mac: publicationMac(unsignedPublication, options.token) })}\n`,
      ),
      options.ownerUid,
      options.ownerGid,
    );
    syncDirectory(options.directory);
    runPublicationHook(options.afterPublicationIntentWrite);
    const unsignedOwner: UnsignedOwner = {
      version: 2,
      participant: options.participant,
      operationKey: options.operationKey,
      processInstance: PROCESS_INSTANCE,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      pid: process.pid,
      generation,
      nonce,
      directoryDev: lockIdentity.dev,
      directoryIno: lockIdentity.ino,
      ttlMs,
    };
    const owner: OwnerRecord = { ...unsignedOwner, mac: ownerMac(unsignedOwner, options.token) };
    createdFiles.set(
      OWNER_NAME,
      writeRecord(
        join(lockPath, OWNER_NAME),
        Buffer.from(`${JSON.stringify(owner)}\n`),
        options.ownerUid,
        options.ownerGid,
      ),
    );
    runPublicationHook(options.afterOwnerRecordWrite);
    createdFiles.set(
      HEARTBEAT_NAME,
      writeRecord(
        join(lockPath, HEARTBEAT_NAME),
        heartbeatBytes(owner, 0, Date.now(), options.token),
        options.ownerUid,
        options.ownerGid,
      ),
    );
    runPublicationHook(options.afterInitialHeartbeatRecordWrite);
    syncDirectory(lockPath);
    runPublicationHook(options.afterStableLockDirectorySync);
    published = true;
    runPublicationHook(options.afterPublicationCommit);
    syncDirectory(options.directory);
    removeExactFile(publicationPath, publicationIdentity, options.ownerUid, options.ownerGid);
    syncDirectory(options.directory);
  } catch (error) {
    simulatedCrash = error instanceof SimulatedPublicationCrash;
    throw error;
  } finally {
    if (!published && !simulatedCrash) {
      if (lockIdentity) {
        const currentDirectory = validateDirectory(
          lockPath,
          options.ownerUid,
          options.ownerGid,
          lockIdentity,
        );
        if (currentDirectory.dev !== lockIdentity.dev || currentDirectory.ino !== lockIdentity.ino)
          fail();
        for (const [name, identity] of createdFiles) {
          removeExactFile(join(lockPath, name), identity, options.ownerUid, options.ownerGid);
        }
        syncDirectory(lockPath);
        rmdirSync(lockPath);
        syncDirectory(options.directory);
      } else if (createdLockIdentity) {
        const current = lstatSync(lockPath);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== createdLockIdentity.dev ||
          current.ino !== createdLockIdentity.ino ||
          readdirSync(lockPath).length !== 0
        )
          fail();
        rmdirSync(lockPath);
        syncDirectory(options.directory);
      }
      if (publicationIdentity) {
        removeExactFile(publicationPath, publicationIdentity, options.ownerUid, options.ownerGid);
        syncDirectory(options.directory);
      }
    }
  }
}

interface GenerationArtifact {
  path: string;
  kind: "tmp" | "recovery";
  generation: string;
}

interface AuthenticatedArtifactRecord<T> {
  path: string;
  identity: FileIdentity;
  record: T;
}

interface ScannedArtifacts {
  generations: Map<string, GenerationArtifact>;
  publications: Map<string, AuthenticatedArtifactRecord<PublicationRecord>>;
  retirements: Map<string, AuthenticatedArtifactRecord<RetirementRecord>>;
}

function readArtifactRecord<T>(
  path: string,
  options: TrustedConfigurationQueueLockOptions,
  authenticate: (bytes: Buffer, token: string) => T,
): AuthenticatedArtifactRecord<T> {
  try {
    const identity = readExactFile(path, options.ownerUid, options.ownerGid);
    return { path, identity, record: authenticate(identity.bytes, options.token) };
  } catch (error) {
    if (error instanceof ArtifactGuidanceError) throw error;
    artifactGuidance();
  }
}

function scanArtifacts(options: TrustedConfigurationQueueLockOptions): ScannedArtifacts {
  const generations = new Map<string, GenerationArtifact>();
  const publications = new Map<string, AuthenticatedArtifactRecord<PublicationRecord>>();
  const retirements = new Map<string, AuthenticatedArtifactRecord<RetirementRecord>>();
  const directory = opendirSync(options.directory);
  let work = 0;
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      work += 1;
      if (work > MAX_ARTIFACT_SCAN_WORK) artifactGuidance();
      if (!entry.name.startsWith(`${OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME}.`)) continue;
      const generationMatch = ARTIFACT.exec(entry.name);
      if (generationMatch) {
        const generation = generationMatch[2];
        if (generations.has(generation)) artifactGuidance();
        generations.set(generation, {
          path: join(options.directory, entry.name),
          kind: generationMatch[1] as "tmp" | "recovery",
          generation,
        });
        continue;
      }
      const publicationMatch = PUBLICATION.exec(entry.name);
      if (publicationMatch) {
        const generation = publicationMatch[1];
        if (publications.has(generation)) artifactGuidance();
        const artifact = readArtifactRecord(
          join(options.directory, entry.name),
          options,
          authenticatedPublication,
        );
        if (artifact.record.generation !== generation) artifactGuidance();
        publications.set(generation, artifact);
        continue;
      }
      const retirementMatch = RETIREMENT.exec(entry.name);
      if (retirementMatch) {
        const generation = retirementMatch[1];
        if (retirements.has(generation)) artifactGuidance();
        const artifact = readArtifactRecord(
          join(options.directory, entry.name),
          options,
          authenticatedRetirement,
        );
        if (artifact.record.generation !== generation) artifactGuidance();
        retirements.set(generation, artifact);
        continue;
      }
      artifactGuidance();
    }
  } finally {
    directory.closeSync();
  }
  return { generations, publications, retirements };
}

function removeArtifactRecord<T>(
  artifact: AuthenticatedArtifactRecord<T>,
  options: TrustedConfigurationQueueLockOptions,
): void {
  removeExactFile(artifact.path, artifact.identity, options.ownerUid, options.ownerGid);
  syncDirectory(options.directory);
}

function validatePublicationRoot(
  publication: PublicationRecord,
  root: { dev: number; ino: number },
): void {
  if (publication.rootDev !== root.dev || publication.rootIno !== root.ino) artifactGuidance();
}

function validateOwnerForPublication(owner: OwnerRecord, publication: PublicationRecord): void {
  if (
    owner.participant !== publication.participant ||
    owner.operationKey !== publication.operationKey ||
    owner.processInstance !== publication.processInstance ||
    owner.processStartedAtMs !== publication.processStartedAtMs ||
    owner.pid !== publication.pid ||
    owner.generation !== publication.generation ||
    owner.nonce !== publication.nonce
  )
    artifactGuidance();
}

function removePartialPublicationDirectory(
  artifact: GenerationArtifact,
  publication: PublicationRecord,
  options: TrustedConfigurationQueueLockOptions,
): void {
  let directory: { dev: number; ino: number };
  try {
    directory = validateDirectory(artifact.path, options.ownerUid, options.ownerGid, {
      dev: publication.directoryDev,
      ino: publication.directoryIno,
    });
  } catch {
    artifactGuidance();
  }
  const names = readdirSync(artifact.path).sort();
  if (names.some((name) => ![OWNER_NAME, HEARTBEAT_NAME].includes(name))) artifactGuidance();
  const exactFiles: Array<{ name: string; identity: FileIdentity }> = [];
  if (names.includes(OWNER_NAME)) {
    const identity = readExactFile(
      join(artifact.path, OWNER_NAME),
      options.ownerUid,
      options.ownerGid,
    );
    const owner = authenticatedOwner(identity.bytes, options.token);
    validateOwnerForPublication(owner, publication);
    if (owner.directoryDev !== directory.dev || owner.directoryIno !== directory.ino) {
      artifactGuidance();
    }
    exactFiles.push({ name: OWNER_NAME, identity });
  }
  if (names.includes(HEARTBEAT_NAME)) {
    const identity = readExactFile(
      join(artifact.path, HEARTBEAT_NAME),
      options.ownerUid,
      options.ownerGid,
    );
    const heartbeat = authenticatedHeartbeat(identity.bytes, options.token);
    if (heartbeat.generation !== publication.generation || heartbeat.nonce !== publication.nonce)
      artifactGuidance();
    exactFiles.push({ name: HEARTBEAT_NAME, identity });
  }
  for (const file of exactFiles) {
    removeExactFile(
      join(artifact.path, file.name),
      file.identity,
      options.ownerUid,
      options.ownerGid,
    );
    syncDirectory(artifact.path);
  }
  validateDirectory(artifact.path, options.ownerUid, options.ownerGid, directory);
  if (readdirSync(artifact.path).length !== 0) artifactGuidance();
  rmdirSync(artifact.path);
  syncDirectory(options.directory);
}

function reconcileRetirement(
  artifact: GenerationArtifact | undefined,
  retirementArtifact: AuthenticatedArtifactRecord<RetirementRecord>,
  options: TrustedConfigurationQueueLockOptions,
): void {
  const retirement = retirementArtifact.record;
  if (!artifact) {
    const lockPath = join(options.directory, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
    try {
      validateDirectory(lockPath, options.ownerUid, options.ownerGid, {
        dev: retirement.directoryDev,
        ino: retirement.directoryIno,
      });
      artifact = { path: lockPath, kind: "recovery", generation: retirement.generation };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") artifactGuidance();
    }
    if (!artifact) {
      removeArtifactRecord(retirementArtifact, options);
      return;
    }
  }
  let directory: { dev: number; ino: number };
  try {
    directory = validateDirectory(artifact.path, options.ownerUid, options.ownerGid, {
      dev: retirement.directoryDev,
      ino: retirement.directoryIno,
    });
  } catch {
    artifactGuidance();
  }
  const names = readdirSync(artifact.path).sort();
  if (names.some((name) => ![OWNER_NAME, HEARTBEAT_NAME].includes(name))) artifactGuidance();
  const exactFiles: Array<{ name: string; identity: FileIdentity }> = [];
  if (names.includes(OWNER_NAME)) {
    const identity = readExactFile(
      join(artifact.path, OWNER_NAME),
      options.ownerUid,
      options.ownerGid,
    );
    const owner = authenticatedOwner(identity.bytes, options.token);
    if (
      owner.generation !== retirement.generation ||
      owner.nonce !== retirement.nonce ||
      owner.directoryDev !== directory.dev ||
      owner.directoryIno !== directory.ino ||
      contentDigest(identity.bytes) !== retirement.ownerDigest
    )
      artifactGuidance();
    exactFiles.push({ name: OWNER_NAME, identity });
  }
  if (names.includes(HEARTBEAT_NAME)) {
    const identity = readExactFile(
      join(artifact.path, HEARTBEAT_NAME),
      options.ownerUid,
      options.ownerGid,
    );
    const heartbeat = authenticatedHeartbeat(identity.bytes, options.token);
    if (
      heartbeat.generation !== retirement.generation ||
      heartbeat.nonce !== retirement.nonce ||
      contentDigest(identity.bytes) !== retirement.heartbeatDigest
    )
      artifactGuidance();
    exactFiles.push({ name: HEARTBEAT_NAME, identity });
  }
  for (const file of exactFiles) {
    removeExactFile(
      join(artifact.path, file.name),
      file.identity,
      options.ownerUid,
      options.ownerGid,
    );
    syncDirectory(artifact.path);
  }
  validateDirectory(artifact.path, options.ownerUid, options.ownerGid, directory);
  if (readdirSync(artifact.path).length !== 0) artifactGuidance();
  rmdirSync(artifact.path);
  syncDirectory(options.directory);
  removeArtifactRecord(retirementArtifact, options);
}

function reconcilePublication(
  artifact: GenerationArtifact | undefined,
  publicationArtifact: AuthenticatedArtifactRecord<PublicationRecord>,
  options: TrustedConfigurationQueueLockOptions,
  root: { dev: number; ino: number },
  nowMs: number,
): boolean {
  const publication = publicationArtifact.record;
  validatePublicationRoot(publication, root);
  if (!artifact) {
    const lockPath = join(options.directory, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
    try {
      const liveDirectory = validateDirectory(lockPath, options.ownerUid, options.ownerGid, {
        dev: publication.directoryDev,
        ino: publication.directoryIno,
      });
      try {
        const live = inspectGeneration(lockPath, options, liveDirectory);
        if (live.owner.generation !== publication.generation) artifactGuidance();
        validateOwnerForPublication(live.owner, publication);
        if (publication.expiresAtMs > nowMs) return true;
        removeGeneration(lockPath, options, live);
      } catch (error) {
        if (error instanceof ArtifactGuidanceError) throw error;
        if (publication.expiresAtMs > nowMs) return true;
        removePartialPublicationDirectory(
          { path: lockPath, kind: "tmp", generation: publication.generation },
          publication,
          options,
        );
      }
      removeArtifactRecord(publicationArtifact, options);
      return false;
    } catch (error) {
      if (error instanceof ArtifactGuidanceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") artifactGuidance();
    }
    if (publication.expiresAtMs > nowMs) return true;
    removeArtifactRecord(publicationArtifact, options);
    return false;
  }
  if (publication.expiresAtMs > nowMs) return true;
  try {
    const inspected = inspectGeneration(artifact.path, options);
    validateOwnerForPublication(inspected.owner, publication);
    removeGeneration(artifact.path, options, inspected);
  } catch (error) {
    if (error instanceof ArtifactGuidanceError) throw error;
    removePartialPublicationDirectory(artifact, publication, options);
  }
  removeArtifactRecord(publicationArtifact, options);
  return false;
}

function reconcileArtifacts(options: TrustedConfigurationQueueLockOptions, nowMs: number): boolean {
  const root = validateDirectory(options.directory, options.ownerUid, options.ownerGid);
  const scanned = scanArtifacts(options);

  for (const [generation, retirement] of scanned.retirements) {
    const artifact = scanned.generations.get(generation);
    reconcileRetirement(artifact, retirement, options);
    scanned.generations.delete(generation);
    scanned.retirements.delete(generation);
    const publication = scanned.publications.get(generation);
    if (publication) {
      removeArtifactRecord(publication, options);
      scanned.publications.delete(generation);
    }
  }

  let live = false;
  for (const [generation, publication] of scanned.publications) {
    const artifact = scanned.generations.get(generation);
    if (reconcilePublication(artifact, publication, options, root, nowMs)) live = true;
    else scanned.generations.delete(generation);
    scanned.publications.delete(generation);
  }

  for (const artifact of scanned.generations.values()) {
    let inspected: InspectedGeneration;
    try {
      inspected = inspectGeneration(artifact.path, options);
    } catch {
      artifactGuidance();
    }
    if (inspected.heartbeat.expiresAtMs > nowMs) {
      live = true;
      continue;
    }
    removeGeneration(artifact.path, options, inspected);
  }

  const remaining = scanArtifacts(options);
  const retained =
    remaining.generations.size + remaining.publications.size + remaining.retirements.size;
  if (retained > MAX_ARTIFACTS) fail();
  return live || retained > 0;
}

function quarantineExpiredLock(
  options: TrustedConfigurationQueueLockOptions,
  inspected: InspectedGeneration,
  nowMs: number,
): boolean {
  if (inspected.renewal || inspected.heartbeat.expiresAtMs > nowMs) return false;
  const lockPath = join(options.directory, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
  const recoveryPath = join(
    options.directory,
    `${OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME}.recovery.${inspected.owner.generation}`,
  );
  renameSync(lockPath, recoveryPath);
  syncDirectory(options.directory);
  const quarantined = inspectGeneration(recoveryPath, options, inspected.directory);
  if (
    quarantined.owner.generation !== inspected.owner.generation ||
    quarantined.owner.nonce !== inspected.owner.nonce ||
    quarantined.ownerIdentity.dev !== inspected.ownerIdentity.dev ||
    quarantined.ownerIdentity.ino !== inspected.ownerIdentity.ino ||
    quarantined.heartbeatIdentity.dev !== inspected.heartbeatIdentity.dev ||
    quarantined.heartbeatIdentity.ino !== inspected.heartbeatIdentity.ino ||
    !equalBytes(quarantined.ownerIdentity.bytes, inspected.ownerIdentity.bytes) ||
    !equalBytes(quarantined.heartbeatIdentity.bytes, inspected.heartbeatIdentity.bytes) ||
    quarantined.heartbeat.expiresAtMs > nowMs
  ) {
    renameSync(recoveryPath, lockPath);
    syncDirectory(options.directory);
    return false;
  }
  removeGeneration(recoveryPath, options, quarantined);
  return true;
}

function isExactEmptyStableLock(
  path: string,
  options: TrustedConfigurationQueueLockOptions,
): boolean {
  try {
    validateDirectory(path, options.ownerUid, options.ownerGid);
    const directory = opendirSync(path);
    try {
      return directory.readSync() === null;
    } finally {
      directory.closeSync();
    }
  } catch {
    return false;
  }
}

function discardExpiredRenewal(
  path: string,
  options: TrustedConfigurationQueueLockOptions,
  inspected: InspectedGeneration,
  nowMs: number,
): boolean {
  if (!inspected.renewal || inspected.renewal.heartbeat.expiresAtMs > nowMs) return false;
  const current = inspectGeneration(path, options, inspected.directory);
  if (
    !current.renewal ||
    current.owner.generation !== inspected.owner.generation ||
    current.owner.nonce !== inspected.owner.nonce ||
    current.renewal.name !== inspected.renewal.name ||
    current.renewal.identity.dev !== inspected.renewal.identity.dev ||
    current.renewal.identity.ino !== inspected.renewal.identity.ino ||
    !equalBytes(current.renewal.identity.bytes, inspected.renewal.identity.bytes) ||
    current.renewal.heartbeat.expiresAtMs > nowMs
  )
    fail();
  unlinkSync(join(path, inspected.renewal.name));
  syncDirectory(path);
  return true;
}

function createLease(
  options: TrustedConfigurationQueueLockOptions,
  ttlMs: number,
): TrustedConfigurationQueueLock {
  const lockPath = join(options.directory, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
  let inspected = inspectGeneration(lockPath, options);
  if (
    inspected.owner.participant !== options.participant ||
    inspected.owner.operationKey !== options.operationKey ||
    inspected.owner.processInstance !== PROCESS_INSTANCE
  )
    fail();
  if (ACTIVE_PROCESS_GENERATIONS.has(inspected.owner.generation)) fail();
  ACTIVE_PROCESS_GENERATIONS.add(inspected.owner.generation);
  let active = true;
  let lost = false;
  let timer: NodeJS.Timeout | undefined;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const unregister = (): void => {
    ACTIVE_PROCESS_GENERATIONS.delete(inspected.owner.generation);
  };
  const renew = (): void => {
    if (!active || lost) fail();
    const current = inspectGeneration(lockPath, options, inspected.directory);
    if (
      current.renewal ||
      current.owner.generation !== inspected.owner.generation ||
      current.owner.nonce !== inspected.owner.nonce ||
      current.ownerIdentity.ino !== inspected.ownerIdentity.ino ||
      !equalBytes(current.ownerIdentity.bytes, inspected.ownerIdentity.bytes) ||
      current.heartbeatIdentity.ino !== inspected.heartbeatIdentity.ino ||
      !equalBytes(current.heartbeatIdentity.bytes, inspected.heartbeatIdentity.bytes) ||
      current.heartbeat.expiresAtMs <= Date.now()
    )
      fail();
    const sequence = current.heartbeat.sequence + 1;
    const temporary = join(lockPath, `.heartbeat.${sequence}.${inspected.owner.nonce}.tmp`);
    const bytes = heartbeatBytes(current.owner, sequence, Date.now(), options.token);
    const nextIdentity = writeRecord(temporary, bytes, options.ownerUid, options.ownerGid);
    options.afterHeartbeatRecordWrite?.();
    renameSync(temporary, join(lockPath, HEARTBEAT_NAME));
    syncDirectory(lockPath);
    const next = inspectGeneration(lockPath, options, inspected.directory);
    if (
      next.heartbeatIdentity.dev !== nextIdentity.dev ||
      next.heartbeatIdentity.ino !== nextIdentity.ino ||
      !equalBytes(next.heartbeatIdentity.bytes, bytes)
    )
      fail();
    inspected = next;
  };

  timer = setInterval(
    () => {
      try {
        renew();
      } catch {
        lost = true;
        stop();
        unregister();
      }
    },
    Math.max(10, Math.floor(ttlMs / 3)),
  );
  timer.unref();

  return {
    assertHeld: () => {
      try {
        renew();
      } catch {
        lost = true;
        stop();
        unregister();
        fail();
      }
    },
    release: () => {
      if (!active) return;
      stop();
      try {
        if (lost) fail();
        const current = inspectGeneration(lockPath, options, inspected.directory);
        if (
          current.owner.generation !== inspected.owner.generation ||
          current.owner.nonce !== inspected.owner.nonce
        )
          fail();
        const recoveryPath = join(
          options.directory,
          `${OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME}.recovery.${inspected.owner.generation}`,
        );
        renameSync(lockPath, recoveryPath);
        syncDirectory(options.directory);
        const quarantined = inspectGeneration(recoveryPath, options, inspected.directory);
        removeGeneration(recoveryPath, options, quarantined);
        active = false;
        unregister();
      } catch {
        lost = true;
        unregister();
        fail();
      }
    },
    abandon: () => {
      if (!active) return;
      stop();
      lost = true;
      active = false;
      unregister();
    },
  };
}

export async function acquireTrustedConfigurationQueueLock(
  options: TrustedConfigurationQueueLockOptions,
): Promise<TrustedConfigurationQueueLock> {
  try {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    if (
      !Number.isInteger(ttlMs) ||
      ttlMs < MIN_TTL_MS ||
      ttlMs > MAX_TTL_MS ||
      !Number.isInteger(acquireTimeoutMs) ||
      acquireTimeoutMs < 0 ||
      acquireTimeoutMs > MAX_ACQUIRE_TIMEOUT_MS ||
      !Number.isInteger(retryMs) ||
      retryMs < 1 ||
      retryMs > 1_000 ||
      !/^(?:opk1_[A-Za-z0-9_-]{16,64}|startup)$/.test(options.operationKey)
    )
      fail();
    validateDirectory(options.directory, options.ownerUid, options.ownerGid);
    const deadline = Date.now() + acquireTimeoutMs;
    const lockPath = join(options.directory, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
    while (true) {
      const nowMs = Date.now();
      const artifactsLive = reconcileArtifacts(options, nowMs);
      try {
        lstatSync(lockPath);
        let inspected: InspectedGeneration;
        try {
          inspected = inspectGeneration(lockPath, options);
        } catch (error) {
          if (!artifactsLive && isExactEmptyStableLock(lockPath, options)) artifactGuidance();
          throw error;
        }
        if (ACTIVE_PROCESS_GENERATIONS.has(inspected.owner.generation)) {
          if (Date.now() >= deadline) fail();
          await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
          continue;
        }
        if (discardExpiredRenewal(lockPath, options, inspected, nowMs)) continue;
        if (inspected.renewal) {
          if (Date.now() >= deadline) fail();
          await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
          continue;
        }
        if (!artifactsLive && quarantineExpiredLock(options, inspected, nowMs)) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (artifactsLive) {
            if (Date.now() >= deadline) fail();
            await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
            continue;
          }
          try {
            publishGeneration(options, ttlMs);
            return createLease(options, ttlMs);
          } catch (publishError) {
            if (
              !["EEXIST", "ENOTEMPTY"].includes((publishError as NodeJS.ErrnoException).code ?? "")
            )
              throw publishError;
          }
        } else {
          throw error;
        }
      }
      if (Date.now() >= deadline) fail();
      await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  } catch (error) {
    if (error instanceof ArtifactGuidanceError) throw error;
    fail();
  }
}
