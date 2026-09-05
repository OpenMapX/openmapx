import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const PRIVACY_CIPHER_VERSION = 1;
export const PRIVACY_AAD_VERSION = 1;
export const PRIVACY_MASTER_KEY_RING_FORMAT_VERSION = 1;
export const PRIVACY_MASTER_KEY_RING_MAX_KEYS = 8;
const MAX_MASTER_KEY_RING_FILE_BYTES = 2_048;
export type PrivacyCryptoPurpose =
  | "export-artifact"
  | "request-locator"
  | "email-challenge-recipient"
  | "protected-note"
  | "source-snapshot"
  | "attachment";

export interface MasterKeyRing {
  activeVersion: number;
  activeKey: Buffer;
  keys: Map<number, Buffer>;
}

export interface MasterKeyRingMetadata {
  activeVersion: number;
  availableVersions: number[];
}

export interface CryptoEnvelope {
  cipherVersion: number;
  aadVersion: number;
  masterKeyVersion: number;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface WrappedDataKey {
  version: number;
  iv: string;
  ciphertext: string;
  tag: string;
  masterKeyVersion: number;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.byteLength !== 32)
    throw new Error("Privacy master key must be 32 bytes");
}

function decodeKey(value: string, allowOuterWhitespace = false): Buffer {
  const candidate = allowOuterWhitespace ? value.trim() : value;
  const raw = Buffer.from(candidate, "base64url");
  if (raw.byteLength !== 32 || raw.toString("base64url") !== candidate) {
    throw new Error("Privacy master key must be canonical 32-byte base64url");
  }
  return raw;
}

export interface LoadMasterKeyOptions {
  env?: NodeJS.ProcessEnv;
  /** Test-only I/O seam. Production file loads use an O_NOFOLLOW descriptor. */
  readFile?: (path: string) => Promise<string>;
  /** Test-only hook used to exercise descriptor stability checks with real files. */
  fileReadHooks?: { afterRead?: () => void | Promise<void> };
}

function expectedOwnerUid(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.OPENMAPX_EXPORTS_KEY_UID?.trim();
  if (!raw) return process.getuid?.();
  if (!/^\d+$/.test(raw)) throw new Error("Privacy export key owner UID is invalid");
  const uid = Number(raw);
  if (!Number.isSafeInteger(uid) || uid < 0)
    throw new Error("Privacy export key owner UID is invalid");
  return uid;
}

function assertDedicatedKeyStats(
  stats: {
    isFile(): boolean;
    mode: number;
    nlink: number;
    size: number;
    uid: number;
  },
  expectedUid: number | undefined,
): void {
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error("Privacy export key must be a single regular file");
  }
  if ((stats.mode & 0o7777) !== 0o400) {
    throw new Error("Privacy export key file permissions are unsafe");
  }
  if (expectedUid !== undefined && stats.uid !== expectedUid) {
    throw new Error("Privacy export key file owner is unexpected");
  }
  if (stats.size < 1 || stats.size > MAX_MASTER_KEY_RING_FILE_BYTES) {
    throw new Error("Privacy export key file exceeds the size limit");
  }
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validKeyVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function ringFromKey(key: Buffer): MasterKeyRing {
  return { activeVersion: 1, activeKey: key, keys: new Map([[1, key]]) };
}

function parsePersistedMasterKeyRing(contents: string): MasterKeyRing {
  if (Buffer.byteLength(contents, "utf8") > MAX_MASTER_KEY_RING_FILE_BYTES) {
    throw new Error("Privacy export key file exceeds the size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Privacy export key ring is invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    JSON.stringify(parsed) !== contents
  ) {
    throw new Error("Privacy export key ring is invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (!exactObjectKeys(value, ["activeVersion", "formatVersion", "keys"])) {
    throw new Error("Privacy export key ring is invalid");
  }
  if (value.formatVersion !== PRIVACY_MASTER_KEY_RING_FORMAT_VERSION) {
    throw new Error("Privacy export key ring format is unsupported");
  }
  if (
    !validKeyVersion(value.activeVersion) ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > PRIVACY_MASTER_KEY_RING_MAX_KEYS
  ) {
    throw new Error("Privacy export key ring is invalid");
  }

  const keys = new Map<number, Buffer>();
  for (const entry of value.keys) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Privacy export key ring is invalid");
    }
    const candidate = entry as Record<string, unknown>;
    if (
      !exactObjectKeys(candidate, ["key", "version"]) ||
      !validKeyVersion(candidate.version) ||
      typeof candidate.key !== "string" ||
      keys.has(candidate.version)
    ) {
      throw new Error("Privacy export key ring is invalid");
    }
    let key: Buffer;
    try {
      key = decodeKey(candidate.key);
    } catch {
      throw new Error("Privacy export key ring is invalid");
    }
    keys.set(candidate.version, key);
  }
  const activeKey = keys.get(value.activeVersion);
  if (!activeKey) throw new Error("Privacy export key ring is invalid");
  return { activeVersion: value.activeVersion, activeKey, keys };
}

async function readDedicatedKeyFile(
  path: string,
  expectedUid: number | undefined,
  hooks: LoadMasterKeyOptions["fileReadHooks"] = {},
): Promise<MasterKeyRing> {
  let handle: Awaited<ReturnType<typeof openFile>>;
  try {
    handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error("Privacy export key file is unavailable");
  }
  try {
    const before = await handle.stat();
    assertDedicatedKeyStats(before, expectedUid);
    const buffer = Buffer.alloc(before.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new Error("Privacy export key file is truncated");
    await hooks.afterRead?.();
    const after = await handle.stat();
    assertDedicatedKeyStats(after, expectedUid);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.nlink !== before.nlink ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Privacy export key file changed while it was read");
    }
    return parsePersistedMasterKeyRing(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** Load the dedicated export key. Managed deployments must use a versioned key-ring file. */
export function loadMasterKeyRing(options: LoadMasterKeyOptions = {}): MasterKeyRing {
  const env = options.env ?? process.env;
  const keyFile = env.OPENMAPX_EXPORTS_KEY_FILE?.trim();
  const rawEnv = env.OPENMAPX_EXPORTS_KEY?.trim();
  if (!keyFile && (!rawEnv || env.NODE_ENV === "production")) {
    throw new Error("Privacy export key is unavailable");
  }
  if (keyFile && !isAbsolute(keyFile)) throw new Error("Privacy export key file must be absolute");
  // Synchronous startup callers should use loadMasterKeyRingAsync for a file.
  if (keyFile) throw new Error("Privacy export key file must be loaded asynchronously");
  if (!rawEnv) throw new Error("Privacy export key is unavailable");
  const key = decodeKey(rawEnv);
  return ringFromKey(key);
}

export async function loadMasterKeyRingAsync(
  options: LoadMasterKeyOptions = {},
): Promise<MasterKeyRing> {
  const env = options.env ?? process.env;
  const keyFile = env.OPENMAPX_EXPORTS_KEY_FILE?.trim();
  if (keyFile) {
    if (!isAbsolute(keyFile)) throw new Error("Privacy export key file must be absolute");
    return options.readFile
      ? parsePersistedMasterKeyRing(await options.readFile(keyFile))
      : readDedicatedKeyFile(keyFile, expectedOwnerUid(env), options.fileReadHooks);
  }
  return loadMasterKeyRing(options);
}

export function masterKeyRingMetadata(ring: MasterKeyRing): MasterKeyRingMetadata {
  return {
    activeVersion: ring.activeVersion,
    availableVersions: [...ring.keys.keys()].sort((left, right) => left - right),
  };
}

function masterKeyRingsEqual(left: MasterKeyRing, right: MasterKeyRing): boolean {
  if (left.activeVersion !== right.activeVersion || left.keys.size !== right.keys.size)
    return false;
  for (const [version, leftKey] of left.keys) {
    const rightKey = right.keys.get(version);
    if (
      !rightKey ||
      leftKey.byteLength !== rightKey.byteLength ||
      !timingSafeEqual(leftKey, rightKey)
    ) {
      return false;
    }
  }
  return true;
}

/** Revalidates managed key configuration without changing the startup ring. */
export async function masterKeyRingConfigurationMatches(
  startupRing: MasterKeyRing,
  options: LoadMasterKeyOptions = {},
): Promise<boolean> {
  try {
    return masterKeyRingsEqual(startupRing, await loadMasterKeyRingAsync(options));
  } catch {
    return false;
  }
}

function purposeDomain(purpose: PrivacyCryptoPurpose): Buffer {
  return Buffer.from(`openmapx/privacy/${purpose}/v${PRIVACY_CIPHER_VERSION}`, "utf8");
}

function wrappingKey(masterKey: Buffer, purpose: PrivacyCryptoPurpose, context: string): Buffer {
  assertKey(masterKey);
  return Buffer.from(
    hkdfSync("sha256", masterKey, purposeDomain(purpose), Buffer.from(context, "utf8"), 32),
  );
}

export function makeAad(input: {
  deploymentId: string;
  requestId: string;
  blobId: string;
  purpose: PrivacyCryptoPurpose;
  storageKey?: string;
}): string {
  const values = {
    aadVersion: PRIVACY_AAD_VERSION,
    blobId: input.blobId,
    deploymentId: input.deploymentId,
    purpose: input.purpose,
    requestId: input.requestId,
    storageKey: input.storageKey ?? null,
  };
  return JSON.stringify(values, Object.keys(values).sort());
}

export function encryptEnvelope(
  plaintext: Buffer,
  ring: MasterKeyRing,
  purpose: PrivacyCryptoPurpose,
  aad: string,
): CryptoEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    wrappingKey(ring.activeKey, purpose, "envelope"),
    iv,
  );
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    cipherVersion: PRIVACY_CIPHER_VERSION,
    aadVersion: PRIVACY_AAD_VERSION,
    masterKeyVersion: ring.activeVersion,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptEnvelope(
  envelope: CryptoEnvelope,
  ring: MasterKeyRing,
  purpose: PrivacyCryptoPurpose,
  aad: string,
): Buffer {
  if (
    envelope.cipherVersion !== PRIVACY_CIPHER_VERSION ||
    envelope.aadVersion !== PRIVACY_AAD_VERSION
  ) {
    throw new Error("Unsupported privacy ciphertext version");
  }
  const master = ring.keys.get(envelope.masterKeyVersion);
  if (!master) throw new Error("Privacy ciphertext key version is unavailable");
  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (iv.byteLength !== 12 || tag.byteLength !== 16)
    throw new Error("Invalid privacy ciphertext metadata");
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey(master, purpose, "envelope"), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

export function wrapDataKey(
  dek: Buffer,
  ring: MasterKeyRing,
  purpose: PrivacyCryptoPurpose,
  context: string,
): WrappedDataKey {
  assertKey(dek);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    wrappingKey(ring.activeKey, purpose, `dek:${context}`),
    iv,
  );
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    version: PRIVACY_CIPHER_VERSION,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    masterKeyVersion: ring.activeVersion,
  };
}

export function unwrapDataKey(
  wrapped: WrappedDataKey,
  ring: MasterKeyRing,
  purpose: PrivacyCryptoPurpose,
  context: string,
): Buffer {
  if (wrapped.version !== PRIVACY_CIPHER_VERSION)
    throw new Error("Unsupported wrapped key version");
  const master = ring.keys.get(wrapped.masterKeyVersion);
  if (!master) throw new Error("Wrapped key master version is unavailable");
  const iv = Buffer.from(wrapped.iv, "base64url");
  const tag = Buffer.from(wrapped.tag, "base64url");
  if (iv.byteLength !== 12 || tag.byteLength !== 16)
    throw new Error("Invalid wrapped key metadata");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    wrappingKey(master, purpose, `dek:${context}`),
    iv,
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  const dek = Buffer.concat([
    decipher.update(Buffer.from(wrapped.ciphertext, "base64url")),
    decipher.final(),
  ]);
  assertKey(dek);
  return dek;
}

export function digestBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
