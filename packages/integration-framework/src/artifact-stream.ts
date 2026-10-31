/** Bounded declarative archive extraction. All paths are server-local private staging. */
import { createHash } from "node:crypto";
import { constants as C, closeSync, fstatSync, fsyncSync, openSync, writeSync } from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { AnchoredDirectory } from "@openmapx/core/build-artifacts";

const BLOCK = 512;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
class ByteSource {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array = new Uint8Array(0);
  private offset = 0;
  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly signal: AbortSignal,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  async part(maximum: number): Promise<Uint8Array | null> {
    this.signal.throwIfAborted();
    while (this.offset === this.current.byteLength) {
      const next = await this.iterator.next();
      this.signal.throwIfAborted();
      if (next.done) return null;
      this.current = next.value;
      this.offset = 0;
      if (this.current.byteLength > 1024 ** 2)
        throw Error("Artifact source chunk exceeds bounded decoder limit");
      if (!this.current.byteLength) continue;
    }
    const value = this.current.subarray(this.offset, this.offset + maximum);
    this.offset += value.byteLength;
    return value;
  }
  async exact(
    length: number,
    allowEof = false,
    label = "Artifact tar payload is truncated",
  ): Promise<Buffer | null> {
    const result = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const value = await this.part(length - count);
      if (!value) {
        if (count === 0 && allowEof) return null;
        throw Error(label);
      }
      result.set(value, count);
      count += value.byteLength;
    }
    return result;
  }
  async *remaining(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const part = await this.part(64 * 1024);
      if (!part) return;
      yield part;
    }
  }
  async close() {
    await this.iterator.return?.();
  }
}
function text(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length),
    nul = bytes.indexOf(0);
  return UTF8.decode(bytes.subarray(0, nul < 0 ? undefined : nul));
}
function octal(header: Buffer, start: number, length: number): number {
  const value = text(header, start, length).trim();
  if (value && !/^[0-7]+$/.test(value)) throw Error("Invalid tar numeric field");
  const parsed = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw Error("Invalid tar numeric field");
  return parsed;
}
function pathStructure(value: string, label = "Artifact path"): void {
  if (Buffer.byteLength(value) > 1024) throw Error(`${label} exceeds 1,024 UTF-8 bytes`);
  const parts = value.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length > 32) throw Error(`${label} exceeds 32 components`);
  if (parts.some((p) => Buffer.byteLength(p) > 255))
    throw Error(`${label} component exceeds 255 UTF-8 bytes`);
}
function safePath(value: string): string[] {
  pathStructure(value);
  if (
    !value ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw Error("Unsafe artifact path");
  const parts = value.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw Error("Unsafe artifact path");
  return parts;
}
function pax(bytes: Buffer): Record<string, string> {
  const values: Record<string, string> = {};
  let offset = 0,
    count = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 20)
      throw Error("Invalid PAX payload: unterminated trailing data");
    const raw = bytes.subarray(offset, space).toString("ascii");
    if (!/^\d+$/.test(raw)) throw Error("Invalid PAX record length");
    const length = Number(raw),
      end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      end > bytes.length ||
      bytes[end - 1] !== 10
    )
      throw Error("Invalid PAX record length or terminating newline");
    if (++count > 256) throw Error("PAX payload exceeds 256 records");
    const record = bytes.subarray(space + 1, end - 1),
      equals = record.indexOf(61);
    if (equals <= 0) throw Error("Invalid PAX record: missing key/value separator");
    const key = UTF8.decode(record.subarray(0, equals));
    if (key.includes("sparse") || key === "SCHILY.realsize")
      throw Error("Sparse artifact metadata is not supported");
    if (["path", "linkpath", "size"].includes(key)) {
      const value = UTF8.decode(record.subarray(equals + 1));
      if (key === "path") pathStructure(value);
      if (key === "linkpath") pathStructure(value, "Artifact link target");
      if (Object.hasOwn(values, key)) throw Error("Duplicate PAX override");
      values[key] = value;
    }
    offset = end;
  }
  return values;
}
function openParents(root: AnchoredDirectory, parts: string[]) {
  const opened: AnchoredDirectory[] = [];
  let current = root;
  try {
    for (const part of parts) {
      current = current.directory(part, true, true);
      opened.push(current);
    }
    return {
      parent: current,
      close: () => {
        for (const dir of opened.reverse()) dir.close();
      },
    };
  } catch (error) {
    for (const dir of opened.reverse()) dir.close();
    throw error;
  }
}
export async function extractIntegrationArtifactStream(options: {
  source: AsyncIterable<Uint8Array>;
  destination: string;
  expectedSha256?: string;
  maxArtifactBytes: number;
  maxExpandedBytes: number;
  signal: AbortSignal;
}): Promise<{ archiveSha256: string; expandedBytes: number }> {
  const original = options.source[Symbol.asyncIterator]();
  if (options.signal.aborted) {
    await original.return?.();
    options.signal.throwIfAborted();
  }
  const ownedSource: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => original };
  const hash = createHash("sha256");
  let wireBytes = 0,
    expandedBytes = 0;
  const hashed = async function* () {
    for await (const part of ownedSource) {
      options.signal.throwIfAborted();
      wireBytes += part.byteLength;
      if (!Number.isSafeInteger(wireBytes) || wireBytes > options.maxArtifactBytes)
        throw Error(`Artifact size exceeds max ${options.maxArtifactBytes} bytes`);
      hash.update(part);
      yield part;
    }
  };
  const wire = new ByteSource(hashed(), options.signal);
  let magic: Buffer;
  try {
    const prefix = await wire.exact(2);
    if (!prefix) throw Error("Artifact is empty");
    magic = prefix;
  } catch (error) {
    try {
      await wire.close();
    } finally {
      await original.return?.();
    }
    throw error;
  }
  const supplied = Readable.from(
    (async function* () {
      yield magic;
      yield* wire.remaining();
    })(),
    { objectMode: false, highWaterMark: 64 * 1024 },
  );
  const gzip =
    magic[0] === 0x1f && magic[1] === 0x8b ? createGunzip({ chunkSize: 64 * 1024 }) : undefined;
  if (gzip) {
    supplied.on("error", (error) => {
      gzip.destroy(error);
    });
    supplied.pipe(gzip);
  }
  const expanded = gzip ?? supplied;
  const bounded = async function* () {
    for await (const part of expanded) {
      const bytes = part as Buffer;
      expandedBytes += bytes.byteLength;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > options.maxExpandedBytes)
        throw Error(`Artifact extracted size exceeds max ${options.maxExpandedBytes} bytes`);
      yield bytes;
    }
  };
  const reader = new ByteSource(bounded(), options.signal);
  let root: AnchoredDirectory;
  try {
    root = new AnchoredDirectory(options.destination, undefined, true);
  } catch (error) {
    supplied.destroy();
    gzip?.destroy();
    try {
      await reader.close();
      await wire.close();
    } finally {
      await original.return?.();
    }
    throw error;
  }
  const seen = new Set<string>();
  let headers = 0,
    pending: Record<string, string> = {},
    sawEnd = false;
  const abort = () => {
    supplied.destroy(
      options.signal.reason instanceof Error
        ? options.signal.reason
        : Error("Artifact extraction aborted"),
    );
    gzip?.destroy();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const header = await reader.exact(BLOCK, true, "Artifact contains a partial tar header");
      if (!header) break;
      if (header.every((b) => b === 0)) {
        const second = await reader.exact(BLOCK);
        if (!second?.every((b) => b === 0)) throw Error("Invalid artifact tar end blocks");
        sawEnd = true;
        break;
      }
      if (++headers > 4096) throw Error("Artifact tar header limit exceeded: maximum 4,096");
      const expected = octal(header, 148, 8);
      let checksum = 0;
      for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== expected) throw Error("Invalid artifact tar header checksum");
      const name = text(header, 0, 100),
        prefix = text(header, 345, 155),
        type = text(header, 156, 1) || "0";
      const size = octal(header, 124, 12);
      const rawPath = pending.path ?? (prefix ? `${prefix}/${name}` : name),
        link = pending.linkpath ?? text(header, 157, 100);
      if (["x", "g", "L", "K"].includes(type)) {
        if (size > 16384) throw Error("Artifact extended header exceeds 16 KiB");
        const bytes = await reader.exact(size);
        if (!bytes) throw Error("Truncated artifact metadata");
        if (type === "x" || type === "g") {
          const values = pax(bytes);
          if (type === "x") pending = { ...pending, ...values };
        } else {
          const value = text(bytes, 0, bytes.length);
          pathStructure(value, type === "K" ? "Artifact link target" : "Artifact path");
          pending = { ...pending, [type === "L" ? "path" : "linkpath"]: value };
        }
        const padding = (BLOCK - (size % BLOCK)) % BLOCK;
        if (padding)
          await reader.exact(padding, false, "Artifact tar payload padding is truncated");
        continue;
      }
      if (
        pending.size !== undefined &&
        (!/^\d+$/.test(pending.size) || Number(pending.size) !== size)
      )
        throw Error("Artifact PAX size does not match header");
      pending = {};
      const parts = safePath(rawPath);
      if (link) pathStructure(link, "Artifact link target");
      if (type !== "0" && type !== "5") throw Error(`Unsupported artifact entry type '${type}'`);
      if (!parts.length) {
        if (type !== "5" || size !== 0) throw Error("Unsafe artifact root member");
        continue;
      }
      const path = parts.join("/");
      if (seen.has(path)) throw Error("Duplicate normalized artifact entry");
      seen.add(path);
      if (type === "5") {
        if (size !== 0) throw Error("Artifact directory has a payload");
        const opened = openParents(root, parts);
        opened.close();
        continue;
      }
      const opened = openParents(root, parts.slice(0, -1));
      let fd: number | undefined;
      try {
        fd = openSync(
          opened.parent.name(parts.at(-1)!),
          C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
          0o600,
        );
        let remaining = size;
        while (remaining) {
          const chunk = await reader.part(Math.min(remaining, 64 * 1024));
          if (!chunk) throw Error("Artifact tar payload is truncated");
          opened.parent.check();
          let count = 0;
          while (count < chunk.byteLength)
            count += writeSync(fd, chunk, count, chunk.byteLength - count);
          remaining -= chunk.byteLength;
        }
        fsyncSync(fd);
        const value = fstatSync(fd, { bigint: true }),
          current = opened.parent.fileIdentity(parts.at(-1)!);
        if (
          value.size !== BigInt(size) ||
          value.nlink !== 1n ||
          String(value.dev) !== current.dev ||
          String(value.ino) !== current.ino
        )
          throw Error("Artifact member changed during extraction");
      } finally {
        if (fd !== undefined) closeSync(fd);
        opened.close();
      }
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      if (padding) {
        const bytes = await reader.exact(
          padding,
          false,
          "Artifact tar payload padding is truncated",
        );
        if (!bytes?.every((b) => b === 0)) throw Error("Invalid artifact tar padding");
      }
    }
    if (!sawEnd || Object.keys(pending).length)
      throw Error("Artifact tar is truncated or missing end blocks");
    for await (const trailing of reader.remaining())
      if (trailing.some((byte) => byte !== 0))
        throw Error("Artifact has unexplained trailing data");
    options.signal.throwIfAborted();
    const archiveSha256 = hash.digest("hex");
    if (options.expectedSha256 && archiveSha256 !== options.expectedSha256)
      throw Error("Artifact sha256 mismatch");
    root.check();
    return { archiveSha256, expandedBytes };
  } finally {
    options.signal.removeEventListener("abort", abort);
    supplied.destroy();
    gzip?.destroy();
    try {
      await reader.close();
      await wire.close();
    } finally {
      try {
        await original.return?.();
      } finally {
        root.close();
      }
    }
  }
}
