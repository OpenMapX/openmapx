import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
  DAWARICH_SOURCE_PATHS,
  type DawarichSourceEntryId,
  type DawarichSourceManifestV1,
  dawarichEntryIdForPath,
  dawarichSourceManifestV1Schema,
  dawarichSourcePathForEntryId,
  isDawarichPortableEntryId,
} from "@openmapx/core/privacy";
import type { CollectorSourcePartEntry } from "./collectors.js";
import { EncryptedSourceSpool } from "./encrypted-source-spool.js";

export const DAWARICH_MAX_ENTRIES = 256;
export const DAWARICH_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const DAWARICH_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const DAWARICH_MAX_MANIFEST_BYTES = 256 * 1024;
const BLOCK = 512;
export class DawarichSourcePartError extends Error {
  constructor(
    readonly code:
      | "truncated"
      | "invalid_header"
      | "checksum"
      | "unsafe_path"
      | "duplicate"
      | "unsupported_type"
      | "limit_exceeded"
      | "manifest_mismatch"
      | "trailing_data",
  ) {
    super(code);
  }
}

function octal(bytes: Uint8Array, start: number, length: number): number {
  const text = new TextDecoder()
    .decode(bytes.slice(start, start + length))
    .replace(/\0.*$/u, "")
    .trim();
  if (!text || !/^[0-7]+$/.test(text)) throw new DawarichSourcePartError("invalid_header");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new DawarichSourcePartError("invalid_header");
  return value;
}

function headerName(header: Uint8Array): string {
  const name = new TextDecoder().decode(header.slice(0, 100)).replace(/\0.*$/u, "");
  const prefix = new TextDecoder().decode(header.slice(345, 500)).replace(/\0.*$/u, "");
  const full = prefix ? `${prefix}/${name}` : name;
  if (
    !full ||
    full.includes("\\") ||
    full.includes("\0") ||
    full.startsWith("/") ||
    full.split("/").some((part) => part === ".." || part === "." || part === "")
  )
    throw new DawarichSourcePartError("unsafe_path");
  return full;
}

function verifyChecksum(header: Uint8Array): void {
  const provided = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < header.length; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (provided !== sum) throw new DawarichSourcePartError("checksum");
}

async function* chunks(input: AsyncIterable<Uint8Array> | Readable): AsyncIterable<Uint8Array> {
  for await (const value of input as AsyncIterable<Uint8Array>) {
    if (!(value instanceof Uint8Array)) throw new DawarichSourcePartError("invalid_header");
    yield value;
  }
}

/** Pulls only enough bytes for the current tar member.  The previous parser
 * concatenated the complete response, which made a valid 2 GB source part a
 * second 2 GB allocation in the API. */
class TarByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  private ended = false;
  private received = 0;
  constructor(
    input: AsyncIterable<Uint8Array> | Readable,
    private readonly rawLimit: number,
  ) {
    this.iterator = chunks(input)[Symbol.asyncIterator]();
  }

  private async fill(minimum: number): Promise<void> {
    while (!this.ended && this.buffer.byteLength < minimum) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const value = Buffer.from(next.value);
      this.received += value.byteLength;
      if (this.received > this.rawLimit) throw new DawarichSourcePartError("limit_exceeded");
      this.buffer = this.buffer.byteLength ? Buffer.concat([this.buffer, value]) : value;
    }
  }

  async readExact(length: number): Promise<Buffer | null> {
    await this.fill(length);
    if (this.buffer.byteLength === 0 && this.ended) return null;
    if (this.buffer.byteLength < length) throw new DawarichSourcePartError("truncated");
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  async *readChunks(length: number): AsyncIterable<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      await this.fill(1);
      if (this.buffer.byteLength === 0) throw new DawarichSourcePartError("truncated");
      const size = Math.min(remaining, this.buffer.byteLength);
      const value = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      remaining -= size;
      yield value;
    }
  }

  async drainZeros(): Promise<void> {
    while (this.buffer.byteLength || !this.ended) {
      if (!this.buffer.byteLength) await this.fill(1);
      if (this.buffer.some((value) => value !== 0))
        throw new DawarichSourcePartError("trailing_data");
      this.buffer = Buffer.alloc(0);
    }
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

/**
 * Parse the fixed Dawarich tar protocol without extracting to disk.  The
 * parser deliberately buffers one bounded member at a time; callers that
 * need true streaming can use `parseDawarichTarStream` below.
 */
export async function parseDawarichTar(
  input: AsyncIterable<Uint8Array> | Readable,
  limits: { maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number } = {},
): Promise<ParsedDawarichEntry[]> {
  return (await parseDawarichTarInternal(input, limits, undefined, true)).entries;
}

export interface ParsedDawarichEntry {
  id: DawarichSourceEntryId;
  path: string;
  bytes: number;
  sha256: string;
  content: Buffer;
}

export interface DawarichTarStreamSummary {
  entryIds: DawarichSourceEntryId[];
  totalBytes: number;
  manifest: DawarichSourceManifestV1;
}

export interface StreamingDawarichEntry {
  id: DawarichSourceEntryId;
  path: string;
  bytes: number;
  content: AsyncIterable<Uint8Array>;
}

export interface DawarichTarLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

function boundedLimits(limits: DawarichTarLimits): Required<DawarichTarLimits> {
  const maxEntries = limits.maxEntries ?? DAWARICH_MAX_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? DAWARICH_MAX_ENTRY_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DAWARICH_MAX_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > DAWARICH_MAX_ENTRIES ||
    !Number.isSafeInteger(maxEntryBytes) ||
    maxEntryBytes < 1 ||
    maxEntryBytes > DAWARICH_MAX_ENTRY_BYTES ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < 1 ||
    maxTotalBytes > DAWARICH_MAX_TOTAL_BYTES
  )
    throw new DawarichSourcePartError("limit_exceeded");
  return { maxEntries, maxEntryBytes, maxTotalBytes };
}

function parseManifest(
  content: Buffer,
  expected?: { cutoff?: string; subjectUserIdDigest?: string },
): DawarichSourceManifestV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString("utf8"));
  } catch {
    throw new DawarichSourcePartError("manifest_mismatch");
  }
  const parsed = dawarichSourceManifestV1Schema.safeParse(raw);
  if (!parsed.success) throw new DawarichSourcePartError("manifest_mismatch");
  if (expected?.cutoff && parsed.data.cutoff !== expected.cutoff)
    throw new DawarichSourcePartError("manifest_mismatch");
  if (
    expected?.subjectUserIdDigest &&
    parsed.data.subjectUserIdDigest !== expected.subjectUserIdDigest
  )
    throw new DawarichSourcePartError("manifest_mismatch");
  return parsed.data as DawarichSourceManifestV1;
}

function validateObservedManifest(
  manifest: DawarichSourceManifestV1,
  observed: ReadonlyMap<DawarichSourceEntryId, { bytes: number; sha256: string }>,
): void {
  for (const declaration of manifest.entries) {
    const actual = observed.get(declaration.id as DawarichSourceEntryId);
    if (!actual || actual.bytes !== declaration.bytes || actual.sha256 !== declaration.sha256)
      throw new DawarichSourcePartError("manifest_mismatch");
  }
  for (const id of observed.keys()) {
    if (id !== "source-manifest" && !manifest.entries.some((declaration) => declaration.id === id))
      throw new DawarichSourcePartError("manifest_mismatch");
  }
}

function mediaTypeForPath(path: string): string {
  if (path.endsWith(".jsonl")) return "application/jsonl";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function parseDawarichTarInternal(
  input: AsyncIterable<Uint8Array> | Readable,
  limits: DawarichTarLimits,
  onEntry?: (entry: StreamingDawarichEntry) => void | Promise<void>,
  collect = true,
  expected?: { cutoff?: string; subjectUserIdDigest?: string },
): Promise<{ entries: ParsedDawarichEntry[]; stream: DawarichTarStreamSummary | null }> {
  const bounded = boundedLimits(limits);
  const entries: ParsedDawarichEntry[] = [];
  const seen = new Set<DawarichSourceEntryId>();
  const observed = new Map<DawarichSourceEntryId, { bytes: number; sha256: string }>();
  let total = 0;
  let sawEnd = false;
  let sawManifest = false;
  let manifest: DawarichSourceManifestV1 | undefined;
  const rawLimit = bounded.maxTotalBytes + bounded.maxEntries * BLOCK * 2 + BLOCK * 2;
  const reader = new TarByteReader(input, rawLimit);
  try {
    while (true) {
      const header = await reader.readExact(BLOCK);
      if (!header) break;
      if (header.every((value) => value === 0)) {
        const second = await reader.readExact(BLOCK);
        if (!second?.every((value) => value === 0))
          throw new DawarichSourcePartError("trailing_data");
        await reader.drainZeros();
        sawEnd = true;
        break;
      }
      // The manifest is deliberately the final member. This prevents an
      // unaccounted member from being appended after declarations are checked.
      if (sawManifest) throw new DawarichSourcePartError("manifest_mismatch");
      verifyChecksum(header);
      const path = headerName(header);
      const id = dawarichEntryIdForPath(path);
      if (!id) throw new DawarichSourcePartError("unsafe_path");
      if (seen.has(id)) throw new DawarichSourcePartError("duplicate");
      const type = header[156];
      if (type !== 0 && type !== 48) throw new DawarichSourcePartError("unsupported_type");
      const size = octal(header, 124, 12);
      if (
        size > bounded.maxEntryBytes ||
        (id === "source-manifest" && size > DAWARICH_MAX_MANIFEST_BYTES) ||
        total + size > bounded.maxTotalBytes ||
        seen.size >= bounded.maxEntries
      )
        throw new DawarichSourcePartError("limit_exceeded");
      let content: Buffer | undefined;
      const hash = createHash("sha256");
      if (onEntry) {
        let consumed = 0;
        const manifestChunks: Buffer[] = [];
        const memberContent = (async function* () {
          for await (const chunk of reader.readChunks(size)) {
            consumed += chunk.byteLength;
            hash.update(chunk);
            if (id === "source-manifest") manifestChunks.push(chunk);
            yield chunk;
          }
        })();
        await onEntry({ id, path, bytes: size, content: memberContent });
        if (consumed !== size) throw new DawarichSourcePartError("truncated");
        if (id === "source-manifest") content = Buffer.concat(manifestChunks, size);
      } else {
        content = (await reader.readExact(size)) ?? undefined;
        if (!content) throw new DawarichSourcePartError("truncated");
        hash.update(content);
      }
      const sha256 = hash.digest("hex");
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      const paddingBytes = await reader.readExact(padding);
      if (!paddingBytes || paddingBytes.some((value) => value !== 0))
        throw new DawarichSourcePartError("invalid_header");
      total += size;
      seen.add(id);
      observed.set(id, { bytes: size, sha256 });
      const entry = content
        ? ({ id, path, bytes: size, sha256, content } satisfies ParsedDawarichEntry)
        : undefined;
      if (id === "source-manifest") {
        if (!content) throw new DawarichSourcePartError("manifest_mismatch");
        manifest = parseManifest(content, expected);
        sawManifest = true;
      }
      if (collect && entry) entries.push(entry);
    }
    if (!sawEnd || !seen.size) throw new DawarichSourcePartError("truncated");
    if (!manifest) throw new DawarichSourcePartError("manifest_mismatch");
    validateObservedManifest(manifest, observed);
    return { entries, stream: { entryIds: [...seen], totalBytes: total, manifest } };
  } finally {
    await reader.close();
  }
}

/** Parse and validate a source part while yielding one bounded member at a
 * time. No complete tar or plaintext temporary file is retained. */
export async function parseDawarichTarStream(
  input: AsyncIterable<Uint8Array> | Readable,
  onEntry: (entry: StreamingDawarichEntry) => void | Promise<void>,
  limits: DawarichTarLimits & { expected?: { cutoff?: string; subjectUserIdDigest?: string } } = {},
): Promise<DawarichTarStreamSummary> {
  const { expected, ...bounds } = limits;
  const result = await parseDawarichTarInternal(input, bounds, onEntry, false, expected);
  if (!result.stream) throw new DawarichSourcePartError("manifest_mismatch");
  return result.stream;
}

/** Verify the source manifest against all fixed tar members. */
export function validateDawarichManifest(
  entries: readonly ParsedDawarichEntry[],
  expected?: { cutoff?: string; subjectUserIdDigest?: string },
): DawarichSourceManifestV1 {
  const manifestEntry = entries.find((entry) => entry.id === "source-manifest");
  if (!manifestEntry) throw new DawarichSourcePartError("manifest_mismatch");
  let raw: unknown;
  try {
    raw = JSON.parse(manifestEntry.content.toString("utf8"));
  } catch {
    throw new DawarichSourcePartError("manifest_mismatch");
  }
  const manifest = dawarichSourceManifestV1Schema.safeParse(raw);
  if (!manifest.success) throw new DawarichSourcePartError("manifest_mismatch");
  if (expected?.cutoff && manifest.data.cutoff !== expected.cutoff)
    throw new DawarichSourcePartError("manifest_mismatch");
  if (
    expected?.subjectUserIdDigest &&
    manifest.data.subjectUserIdDigest !== expected.subjectUserIdDigest
  )
    throw new DawarichSourcePartError("manifest_mismatch");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const declaration of (manifest.data as DawarichSourceManifestV1).entries) {
    const entry = byId.get(declaration.id as DawarichSourceEntryId);
    if (!entry || declaration.bytes !== entry.bytes || declaration.sha256 !== entry.sha256)
      throw new DawarichSourcePartError("manifest_mismatch");
  }
  for (const entry of entries) {
    // The manifest cannot contain its own digest without a circular value. It
    // is therefore the one fixed member intentionally omitted from the
    // declaration list.
    if (
      entry.id !== "source-manifest" &&
      !manifest.data.entries.some((declaration) => declaration.id === entry.id)
    )
      throw new DawarichSourcePartError("manifest_mismatch");
  }
  return manifest.data;
}

export function asCollectorEntries(
  entries: readonly ParsedDawarichEntry[],
  prefix = "dawarich",
): CollectorSourcePartEntry[] {
  const result: CollectorSourcePartEntry[] = [];
  for (const entry of entries) {
    result.push({
      logicalId: `${prefix}-${entry.id}`,
      source: entry.content,
      mediaType: mediaTypeForPath(entry.path),
      bytes: entry.bytes,
      sha256: entry.sha256,
      schemaId: "dawarich-v1",
    });
    if (isDawarichPortableEntryId(entry.id)) {
      result.push({
        logicalId: `${prefix}-portable-${entry.id}`,
        source: entry.content,
        mediaType: mediaTypeForPath(entry.path),
        bytes: entry.bytes,
        sha256: entry.sha256,
        schemaId: "dawarich-portable-v1",
      });
    }
  }
  return result;
}

export async function spoolDawarichTar(
  input: AsyncIterable<Uint8Array> | Readable,
  options: {
    prefix?: string;
    expected?: { cutoff?: string; subjectUserIdDigest?: string };
    spoolParentDirectory?: string;
  } = {},
): Promise<{ entries: CollectorSourcePartEntry[]; dispose: () => Promise<void> }> {
  const prefix = options.prefix ?? "dawarich";
  const spool = await EncryptedSourceSpool.create({
    parentDirectory: options.spoolParentDirectory,
  });
  const entries: CollectorSourcePartEntry[] = [];
  try {
    await parseDawarichTarStream(
      input,
      async (entry) => {
        const stored = await spool.write({
          logicalId: `${prefix}-${entry.id}`,
          content: entry.content,
          mediaType: mediaTypeForPath(entry.path),
          bytes: entry.bytes,
          schemaId: "dawarich-v1",
        });
        entries.push(stored);
        if (isDawarichPortableEntryId(entry.id)) {
          entries.push({
            ...stored,
            logicalId: `${prefix}-portable-${entry.id}`,
            schemaId: "dawarich-portable-v1",
          });
        }
      },
      { expected: options.expected },
    );
    return { entries, dispose: () => spool.dispose() };
  } catch (error) {
    await spool.dispose();
    throw error;
  }
}

export function fixedDawarichPath(id: DawarichSourceEntryId): string {
  return (
    dawarichSourcePathForEntryId(id) ??
    DAWARICH_SOURCE_PATHS[id as keyof typeof DAWARICH_SOURCE_PATHS]
  );
}
