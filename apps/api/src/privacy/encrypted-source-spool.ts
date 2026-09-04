import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CollectorSourcePartEntry } from "./collectors.js";

interface SpoolRecord {
  path: string;
  iv: Buffer;
  tag: Buffer;
}

const SPOOL_MARKER = "openmapx-encrypted-source-spool-v1";
const SPOOL_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
function linuxProcessStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    return startTicks ? `linux-start-ticks:${startTicks}` : null;
  } catch {
    return null;
  }
}

const PROCESS_INSTANCE =
  linuxProcessStart(process.pid) ??
  `started-at-ms:${Math.round(Date.now() - process.uptime() * 1_000)}`;

export function defaultEncryptedSourceSpoolRoot(): string {
  return join(tmpdir(), "openmapx-privacy-source-spool");
}

export class EncryptedSourceSpool {
  private readonly key = randomBytes(32);
  private readonly records: Array<SpoolRecord | undefined> = [];
  private disposed = false;
  private nextFileId = 0;
  private totalBytes = 0;

  private constructor(
    private readonly directory: string,
    private readonly limits: {
      maxMemberBytes: number;
      maxTotalBytes: number;
      maxFiles: number;
    },
  ) {}

  static async create(
    options: {
      parentDirectory?: string;
      maxMemberBytes?: number;
      maxTotalBytes?: number;
      maxFiles?: number;
    } = {},
  ): Promise<EncryptedSourceSpool> {
    const parent = options.parentDirectory ?? defaultEncryptedSourceSpoolRoot();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("encrypted source spool root is unsafe");
    const directory = await mkdtemp(join(parent, "case-"));
    await writeFile(
      join(directory, "marker.json"),
      `${JSON.stringify({ marker: SPOOL_MARKER, pid: process.pid, processInstance: PROCESS_INSTANCE })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return new EncryptedSourceSpool(directory, {
      maxMemberBytes: options.maxMemberBytes ?? 512 * 1024 * 1024,
      maxTotalBytes: options.maxTotalBytes ?? 2 * 1024 * 1024 * 1024,
      maxFiles: options.maxFiles ?? 512,
    });
  }

  async write(input: {
    logicalId: string;
    content: AsyncIterable<Uint8Array>;
    mediaType: string;
    bytes?: number;
    recordCount?: number;
    schemaId?: string;
  }): Promise<CollectorSourcePartEntry> {
    if (this.disposed) throw new Error("encrypted source spool is disposed");
    if (this.nextFileId >= this.limits.maxFiles)
      throw new Error("source spool file limit exceeded");
    if (input.bytes !== undefined && input.bytes > this.limits.maxMemberBytes)
      throw new Error("source spool member byte limit exceeded");
    if (input.bytes !== undefined && this.totalBytes + input.bytes > this.limits.maxTotalBytes)
      throw new Error("source spool total byte limit exceeded");
    const fileId = this.nextFileId++;
    const path = join(this.directory, `${fileId.toString().padStart(6, "0")}.bin`);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const hash = createHash("sha256");
    let bytes = 0;
    const owner = this;
    const tracker = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const value = Buffer.from(chunk);
        if (bytes + value.byteLength > owner.limits.maxMemberBytes) {
          callback(new Error("source spool member byte limit exceeded"));
          return;
        }
        if (owner.totalBytes + value.byteLength > owner.limits.maxTotalBytes) {
          callback(new Error("source spool total byte limit exceeded"));
          return;
        }
        bytes += value.byteLength;
        owner.totalBytes += value.byteLength;
        hash.update(value);
        callback(null, value);
      },
    });
    try {
      await pipeline(
        Readable.from(input.content),
        tracker,
        cipher,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      if (input.bytes !== undefined && bytes !== input.bytes)
        throw new Error("source spool byte count mismatch");
      const record = { path, iv, tag: cipher.getAuthTag() };
      this.records[fileId] = record;
      const key = this.key;
      return {
        logicalId: input.logicalId,
        source: {
          async *[Symbol.asyncIterator]() {
            const decipher = createDecipheriv("aes-256-gcm", key, record.iv);
            decipher.setAuthTag(record.tag);
            const encrypted = createReadStream(record.path, { highWaterMark: 64 * 1024 });
            const pump = pipeline(encrypted, decipher);
            void pump.catch(() => undefined);
            try {
              for await (const chunk of decipher) yield chunk as Buffer;
              await pump;
            } finally {
              encrypted.destroy();
              decipher.destroy();
              await Promise.allSettled([pump]);
            }
          },
        },
        mediaType: input.mediaType,
        bytes,
        sha256: hash.digest("hex"),
        recordCount: input.recordCount,
        schemaId: input.schemaId,
      };
    } catch (error) {
      this.totalBytes -= bytes;
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.key.fill(0);
    await rm(this.directory, { recursive: true, force: true });
  }

  filesForTesting(): string[] {
    return this.records.flatMap((record) => (record ? [record.path] : []));
  }
}

function processIsAlive(pid: number, processInstance: unknown): boolean {
  if (pid === process.pid) return processInstance === PROCESS_INSTANCE;
  try {
    process.kill(pid, 0);
    const currentInstance = linuxProcessStart(pid);
    if (currentInstance) return processInstance === currentInstance;
    return true;
  } catch {
    return false;
  }
}

export async function janitorEncryptedSourceSpools(
  parentDirectory = defaultEncryptedSourceSpoolRoot(),
  now = Date.now(),
): Promise<{ removed: number; retained: number }> {
  let children: Dirent<string>[];
  try {
    const root = await lstat(parentDirectory);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0)
      return { removed: 0, retained: 0 };
    children = await readdir(parentDirectory, { withFileTypes: true });
  } catch {
    return { removed: 0, retained: 0 };
  }
  let removed = 0;
  let retained = 0;
  for (const child of children.slice(0, 1_024)) {
    if (!child.name.startsWith("case-") || !child.isDirectory() || child.isSymbolicLink()) {
      retained += 1;
      continue;
    }
    const directory = join(parentDirectory, child.name);
    try {
      const [stat, markerText] = await Promise.all([
        lstat(directory),
        readFile(join(directory, "marker.json"), "utf8"),
      ]);
      const marker = JSON.parse(markerText) as {
        marker?: unknown;
        pid?: unknown;
        processInstance?: unknown;
      };
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        (stat.mode & 0o077) !== 0 ||
        marker.marker !== SPOOL_MARKER ||
        !Number.isSafeInteger(marker.pid) ||
        (marker.pid as number) < 1 ||
        typeof marker.processInstance !== "string" ||
        now - stat.mtimeMs < SPOOL_MAX_AGE_MS ||
        processIsAlive(marker.pid as number, marker.processInstance)
      ) {
        retained += 1;
        continue;
      }
      await rm(directory, { recursive: true, force: false });
      removed += 1;
    } catch {
      retained += 1;
    }
  }
  return { removed, retained };
}
