import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, readdir, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import {
  type MasterKeyRing,
  makeAad,
  type PrivacyCryptoPurpose,
  unwrapDataKey,
  wrapDataKey,
} from "./crypto.js";

export interface EncryptedBlobStoreOptions {
  root: string;
  ring: MasterKeyRing;
  deploymentId: string;
  maxBytes?: number;
}

export interface EncryptedBlobWriteInput {
  requestId: string;
  blobId: string;
  purpose: PrivacyCryptoPurpose;
  storageKey: string;
  source: Buffer | Uint8Array | Readable | AsyncIterable<Uint8Array>;
  maxBytes?: number;
}

export interface EncryptedBlobResult {
  requestId: string;
  blobId: string;
  purpose: PrivacyCryptoPurpose;
  storageKey: string;
  path: string;
  plaintextBytes: number;
  ciphertextBytes: number;
  plaintextSha256: string;
  ciphertextSha256: string;
  iv: string;
  tag: string;
  wrappedDek: ReturnType<typeof wrapDataKey>;
  masterKeyVersion: number;
  aad: string;
}

function asIterable(source: EncryptedBlobWriteInput["source"]): AsyncIterable<Uint8Array> {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    return (async function* () {
      yield source;
    })();
  }
  return source as AsyncIterable<Uint8Array>;
}

export class EncryptedBlobStore {
  readonly root: string;
  private readonly maxBytes: number;
  private readonly locks = new Map<
    string,
    { shared: number; exclusive: boolean; waiters: Array<() => void> }
  >();
  constructor(private readonly options: EncryptedBlobStoreOptions) {
    if (!isAbsolute(options.root))
      throw new Error("Privacy artifact storage root must be absolute");
    this.root = resolve(options.root);
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
      throw new Error("Invalid artifact storage bound");
  }

  private assertPrivateStats(
    info: { isDirectory(): boolean; isFile(): boolean; mode: number; nlink: number; uid: number },
    kind: "directory" | "file",
  ): void {
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const ownerOk = expectedUid === undefined || info.uid === expectedUid;
    const specialBits = info.mode & 0o7000;
    const permissions = info.mode & 0o777;
    if (kind === "directory") {
      if (!info.isDirectory() || permissions !== 0o700 || specialBits !== 0 || !ownerOk)
        throw new Error("Privacy artifact storage root must be a private directory");
      return;
    }
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      permissions !== 0o400 ||
      specialBits !== 0 ||
      !ownerOk
    )
      throw new Error("Privacy artifact path is not a private regular file");
  }

  private safeKey(storageKey: string): string {
    if (
      !storageKey ||
      storageKey.length > 512 ||
      isAbsolute(storageKey) ||
      storageKey.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\\\0\p{Cc}]/u.test(storageKey)
    )
      throw new Error("Invalid privacy artifact storage key");
    const candidate = resolve(this.root, storageKey);
    const rel = relative(this.root, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Invalid privacy artifact storage key");
    return candidate;
  }

  /** Validate every existing directory component, not only the leaf.  A
   * private root alone is insufficient if an attacker can replace `objects`
   * (or another storage-key prefix) with a symlink between requests. */
  private async assertPrivateDirectoryChain(path: string): Promise<void> {
    const parent = dirname(path);
    const rel = relative(this.root, parent);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
    let current = this.root;
    for (const component of rel.split(sep).filter(Boolean)) {
      current = join(current, component);
      const info = await lstat(current);
      this.assertPrivateStats(info, "directory");
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    this.assertPrivateStats(rootStat, "directory");
  }

  /** Exercise the real private filesystem and active key ring with a fixed,
   * non-personal payload. A failed cleanup makes the probe fail closed. */
  async probeHealth(): Promise<boolean> {
    const nonce = randomBytes(16).toString("hex");
    const storageKey = `health/${nonce}.bin`;
    let written = false;
    try {
      const result = await this.write({
        requestId: `health-${nonce}`,
        blobId: nonce,
        purpose: "export-artifact",
        storageKey,
        source: Buffer.from("openmapx-privacy-storage-health-v1", "utf8"),
        maxBytes: 64,
      });
      written = true;
      await this.verify(result);
      await this.delete(storageKey);
      written = false;
      return true;
    } catch {
      if (written) await this.delete(storageKey).catch(() => undefined);
      return false;
    }
  }

  async assertSafePath(storageKey: string): Promise<string> {
    const path = this.safeKey(storageKey);
    await this.assertPrivateDirectoryChain(path);
    const info = await lstat(path);
    this.assertPrivateStats(info, "file");
    return path;
  }

  async write(input: EncryptedBlobWriteInput): Promise<EncryptedBlobResult> {
    const path = this.safeKey(input.storageKey);
    const maxBytes = input.maxBytes ?? this.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxBytes)
      throw new Error("Invalid privacy artifact bound");
    await this.initialize();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.assertPrivateDirectoryChain(path);
    const partial = `${path}.${randomBytes(16).toString("hex")}.partial`;
    const handle = await open(
      partial,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const aad = makeAad({
      deploymentId: this.options.deploymentId,
      requestId: input.requestId,
      blobId: input.blobId,
      purpose: input.purpose,
      storageKey: input.storageKey,
    });
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(Buffer.from(aad));
    const plainHash = createHash("sha256");
    const cipherHash = createHash("sha256");
    let plaintextBytes = 0;
    let ciphertextBytes = 0;
    let renamed = false;
    try {
      for await (const chunk of asIterable(input.source)) {
        const buffer = Buffer.from(chunk);
        plaintextBytes += buffer.byteLength;
        if (plaintextBytes > maxBytes) throw new Error("Privacy artifact exceeds size limit");
        plainHash.update(buffer);
        const encrypted = cipher.update(buffer);
        if (encrypted.byteLength) {
          await handle.writeFile(encrypted);
          ciphertextBytes += encrypted.byteLength;
          cipherHash.update(encrypted);
        }
      }
      const final = cipher.final();
      if (final.byteLength) {
        await handle.writeFile(final);
        ciphertextBytes += final.byteLength;
        cipherHash.update(final);
      }
      // Complete the key wrap before publishing the ciphertext.  If wrapping
      // fails, cleanup can remove only the temporary file and no unusable
      // final object is exposed to readers.
      const wrappedDek = wrapDataKey(
        dek,
        this.options.ring,
        input.purpose,
        `${input.requestId}:${input.blobId}`,
      );
      await handle.sync();
      await handle.chmod(0o400);
      await handle.close();
      const info = await lstat(partial);
      this.assertPrivateStats(info, "file");
      // link(2) publishes without replacing an existing object, even when
      // two writers in different processes race on the same storage key.
      await link(partial, path);
      renamed = true;
      await unlink(partial);
      return {
        requestId: input.requestId,
        blobId: input.blobId,
        purpose: input.purpose,
        storageKey: input.storageKey,
        path,
        plaintextBytes,
        ciphertextBytes,
        plaintextSha256: plainHash.digest("hex"),
        ciphertextSha256: cipherHash.digest("hex"),
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        wrappedDek,
        masterKeyVersion: this.options.ring.activeVersion,
        aad,
      };
    } catch (error) {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
      await unlink(partial).catch(() => {});
      if (renamed) await unlink(path).catch(() => {});
      throw error;
    } finally {
      dek.fill(0);
    }
  }

  async decryptTo(
    result: EncryptedBlobResult,
    sink: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<void> {
    await this.withSharedLock(result.storageKey, async () => {
      const handle = await this.openDescriptor(result.storageKey);
      try {
        await this.decryptDescriptor(result, handle, sink);
      } finally {
        await handle.close();
      }
    });
  }

  /** Verify a complete artifact before any response headers/body are emitted. */
  async verify(result: EncryptedBlobResult): Promise<void> {
    await this.withSharedLock(result.storageKey, async () => {
      const handle = await this.openDescriptor(result.storageKey);
      try {
        await this.decryptDescriptor(result, handle, async () => undefined);
      } finally {
        await handle.close();
      }
    });
  }

  /**
   * Authenticated two-pass delivery. The first pass is performed on the same
   * descriptor that is rewound for the response pass, so a replaced file or
   * mode change cannot turn a successful verification into different bytes.
   */
  async decryptToTwoPass(
    result: EncryptedBlobResult,
    sink: (chunk: Uint8Array) => void | Promise<void>,
    options: { beforeSecondPass?: () => void | Promise<void> } = {},
  ): Promise<void> {
    await this.withSharedLock(result.storageKey, async () => {
      const handle = await this.openDescriptor(result.storageKey);
      try {
        await this.decryptDescriptor(result, handle, async () => undefined);
        await options.beforeSecondPass?.();
        await this.assertDescriptorIdentity(handle, result.storageKey);
        await this.decryptDescriptor(result, handle, sink);
      } finally {
        await handle.close();
      }
    });
  }

  private async openDescriptor(storageKey: string): Promise<FileHandle> {
    const path = await this.assertSafePath(storageKey);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      this.assertPrivateStats(info, "file");
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async assertDescriptorIdentity(handle: FileHandle, storageKey: string): Promise<void> {
    const info = await handle.stat();
    this.assertPrivateStats(info, "file");
    const path = await this.assertSafePath(storageKey);
    const named = await lstat(path);
    if (
      named.dev !== info.dev ||
      named.ino !== info.ino ||
      named.size !== info.size ||
      named.uid !== info.uid ||
      (named.mode & 0o7777) !== 0o400
    )
      throw new Error("Privacy artifact identity changed");
  }

  private async decryptDescriptor(
    result: EncryptedBlobResult,
    handle: FileHandle,
    sink: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<void> {
    const dek = unwrapDataKey(
      result.wrappedDek,
      this.options.ring,
      result.purpose,
      `${result.requestId}:${result.blobId}`,
    );
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(result.iv, "base64url"));
    decipher.setAAD(Buffer.from(result.aad));
    decipher.setAuthTag(Buffer.from(result.tag, "base64url"));
    let plaintextBytes = 0;
    const hash = createHash("sha256");
    const ciphertextHash = createHash("sha256");
    let ciphertextBytes = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.byteLength, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
      ciphertextBytes += read.bytesRead;
      ciphertextHash.update(buffer.subarray(0, read.bytesRead));
      const plain = decipher.update(buffer.subarray(0, read.bytesRead));
      if (plain.byteLength) {
        plaintextBytes += plain.byteLength;
        hash.update(plain);
        await sink(plain);
      }
    }
    const final = decipher.final();
    if (final.byteLength) {
      plaintextBytes += final.byteLength;
      hash.update(final);
      await sink(final);
    }
    const plaintextDigest = hash.digest("hex");
    const ciphertextDigest = ciphertextHash.digest("hex");
    if (
      plaintextBytes !== result.plaintextBytes ||
      plaintextDigest !== result.plaintextSha256 ||
      (result.ciphertextBytes !== 0 && ciphertextBytes !== result.ciphertextBytes) ||
      (result.ciphertextSha256 !== "" && ciphertextDigest !== result.ciphertextSha256)
    )
      throw new Error("Privacy artifact integrity check failed");
  }

  private async withSharedLock<T>(storageKey: string, work: () => Promise<T>): Promise<T> {
    const state = await this.acquireLock(storageKey, false);
    try {
      return await work();
    } finally {
      this.releaseLock(storageKey, state, false);
    }
  }

  private async withExclusiveLock<T>(storageKey: string, work: () => Promise<T>): Promise<T> {
    const state = await this.acquireLock(storageKey, true);
    try {
      return await work();
    } finally {
      this.releaseLock(storageKey, state, true);
    }
  }

  private async acquireLock(
    storageKey: string,
    exclusive: boolean,
  ): Promise<{ shared: number; exclusive: boolean; waiters: Array<() => void> }> {
    let state = this.locks.get(storageKey);
    if (!state) {
      state = { shared: 0, exclusive: false, waiters: [] };
      this.locks.set(storageKey, state);
    }
    if ((!exclusive && !state.exclusive) || (exclusive && !state.exclusive && state.shared === 0)) {
      if (exclusive) state.exclusive = true;
      else state.shared += 1;
      return state;
    }
    await new Promise<void>((resolveWaiter) => state?.waiters.push(resolveWaiter));
    return this.acquireLock(storageKey, exclusive);
  }

  private releaseLock(
    storageKey: string,
    state: { shared: number; exclusive: boolean; waiters: Array<() => void> },
    exclusive: boolean,
  ): void {
    if (exclusive) state.exclusive = false;
    else state.shared -= 1;
    const next = state.waiters.shift();
    if (next) next();
    if (!state.exclusive && state.shared === 0 && state.waiters.length === 0)
      this.locks.delete(storageKey);
  }

  async delete(storageKey: string): Promise<void> {
    await this.withExclusiveLock(storageKey, async () => {
      const path = this.safeKey(storageKey);
      await this.assertPrivateDirectoryChain(path);
      const info = await lstat(path).catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "ENOENT"
        )
          return null;
        throw error;
      });
      // A crash can remove ciphertext after its metadata state is persisted but
      // before the cleanup acknowledgement. Treat that case as idempotent.
      if (!info) return;
      this.assertPrivateStats(info, "file");
      await rm(path, { force: false });
    });
  }

  /** Remove only descriptor-safe failed assembly files below this store. */
  async reconcilePartials(): Promise<number> {
    await this.initialize();
    let removed = 0;
    const visit = async (directory: string): Promise<void> => {
      const names = await readdir(directory, { withFileTypes: true });
      for (const entry of names) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        if (!entry.name.endsWith(".partial")) continue;
        const info = await lstat(path).catch(() => undefined);
        if (
          !info ||
          !info.isFile() ||
          info.nlink !== 1 ||
          (info.mode & 0o7000) !== 0 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())
        )
          continue;
        await unlink(path);
        removed += 1;
      }
    };
    await visit(this.root);
    return removed;
  }
}
