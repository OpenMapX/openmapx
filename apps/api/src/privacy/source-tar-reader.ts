import { Readable } from "node:stream";

export const SOURCE_TAR_LIMITS = {
  maxEntries: 256,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
} as const;

export type SourceTarErrorCode =
  | "truncated"
  | "invalid_header"
  | "checksum"
  | "unsafe_path"
  | "duplicate"
  | "unsupported_type"
  | "limit_exceeded"
  | "trailing_data";

export interface SourceTarLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

interface SourceTarMember {
  path: string;
  bytes: number;
  content: AsyncIterable<Buffer>;
}

const BLOCK = 512;
// Python tarfile pads its output to a 20-block record, including the two EOF blocks.
const RECORD = 20 * BLOCK;

/** The uncompressed regular-file USTAR subset used by privacy source protocols.
 * Policy (allowed members, manifests and hashes) belongs to each consumer.
 * Owns the upstream iterator even when initialization fails before the first pull.
 */
export class SourceTarReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  private offset = 0;
  private received = 0;
  private closed = false;
  private readonly rawLimit: number;

  constructor(
    private readonly input: AsyncIterable<Uint8Array> | Readable,
    private readonly limits: SourceTarLimits,
    private readonly error: (code: SourceTarErrorCode) => Error,
  ) {
    this.iterator = input[Symbol.asyncIterator]();
    this.rawLimit = limits.maxTotalBytes + limits.maxEntries * BLOCK * 2 + RECORD;
  }

  private async available(): Promise<boolean> {
    if (this.closed) throw this.error("truncated");
    while (this.offset === this.buffer.length) {
      this.buffer = Buffer.alloc(0);
      this.offset = 0;
      const next = await this.iterator.next();
      if (next.done) return false;
      if (!(next.value instanceof Uint8Array)) throw this.error("invalid_header");
      if (next.value.byteLength > this.rawLimit - this.received) throw this.error("limit_exceeded");
      this.received += next.value.byteLength;
      // Copy once, after admission: upstream producers may reuse their chunk buffer.
      this.buffer = Buffer.from(next.value);
    }
    return true;
  }

  private async exact(length: number): Promise<Buffer | null> {
    if (length === 0) return Buffer.alloc(0);
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      if (!(await this.available())) {
        if (written === 0) return null;
        throw this.error("truncated");
      }
      const count = Math.min(length - written, this.buffer.length - this.offset);
      this.buffer.copy(result, written, this.offset, this.offset + count);
      written += count;
      this.offset += count;
    }
    return result;
  }

  private octal(header: Buffer, start: number, length: number): number {
    const text = header.subarray(start, start + length).toString("utf8");
    if (!/^ *[0-7]+[\0 ]*$/.test(text)) throw this.error("invalid_header");
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value)) throw this.error("invalid_header");
    return value;
  }

  private header(header: Buffer): { path: string; bytes: number } {
    const checksum = this.octal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== sum) throw this.error("checksum");
    if (
      header.toString("utf8", 257, 263) !== "ustar\0" ||
      header.toString("utf8", 263, 265) !== "00"
    )
      throw this.error("invalid_header");
    if (header[156] !== 0 && header[156] !== 48) throw this.error("unsupported_type");
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/u, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/u, "");
    const path = prefix ? `${prefix}/${name}` : name;
    if (
      !path ||
      path.includes("\\") ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw this.error("unsafe_path");
    return { path, bytes: this.octal(header, 124, 12) };
  }

  async read(onMember: (member: SourceTarMember) => void | Promise<void>): Promise<void> {
    try {
      for (const key of ["maxEntries", "maxEntryBytes", "maxTotalBytes"] as const) {
        if (
          !Number.isSafeInteger(this.limits[key]) ||
          this.limits[key] < 1 ||
          this.limits[key] > SOURCE_TAR_LIMITS[key]
        )
          throw this.error("limit_exceeded");
      }
      const seen = new Set<string>();
      let total = 0;
      while (true) {
        const header = await this.exact(BLOCK);
        if (!header) throw this.error("truncated");
        if (header.every((byte) => byte === 0)) {
          const second = await this.exact(BLOCK);
          if (!second) throw this.error("truncated");
          if (second.some((byte) => byte !== 0)) throw this.error("trailing_data");
          while (await this.available()) {
            if (this.buffer.subarray(this.offset).some((byte) => byte !== 0))
              throw this.error("trailing_data");
            this.offset = this.buffer.length;
          }
          break;
        }
        const { path, bytes } = this.header(header);
        if (seen.has(path)) throw this.error("duplicate");
        if (
          bytes > this.limits.maxEntryBytes ||
          bytes > this.limits.maxTotalBytes - total ||
          seen.size >= this.limits.maxEntries
        )
          throw this.error("limit_exceeded");
        seen.add(path);
        total += bytes;
        let remaining = bytes;
        let active = true;
        const reader = this;
        const content = (async function* () {
          while (remaining > 0) {
            if (!active || !(await reader.available())) throw reader.error("truncated");
            const count = Math.min(remaining, reader.buffer.length - reader.offset);
            const chunk = reader.buffer.subarray(reader.offset, reader.offset + count);
            reader.offset += count;
            remaining -= count;
            yield chunk;
          }
        })();
        try {
          await onMember({ path, bytes, content });
        } finally {
          active = false;
          await content.return(undefined);
        }
        if (remaining !== 0) throw this.error("truncated");
        const padding = await this.exact((BLOCK - (bytes % BLOCK)) % BLOCK);
        if (!padding) throw this.error("truncated");
        if (padding.some((byte) => byte !== 0)) throw this.error("invalid_header");
      }
    } catch (error) {
      // A cleanup failure must not replace the original parser/consumer/upstream error.
      await this.close().catch(() => {});
      throw error;
    }
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    if (this.input instanceof Readable) this.input.destroy();
    await this.iterator.return?.();
  }
}
