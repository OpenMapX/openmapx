import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
  type DawarichSourceEntryId,
  type DawarichSourceManifestV1,
  dawarichEntryIdForPath,
  dawarichSourceManifestV1Schema,
  isDawarichPortableEntryId,
} from "@openmapx/core/privacy";
import type { CollectorSourcePartEntry } from "./collectors.js";
import { EncryptedSourceSpool } from "./encrypted-source-spool.js";
import {
  SOURCE_TAR_LIMITS,
  type SourceTarErrorCode,
  SourceTarReader,
} from "./source-tar-reader.js";

export const DAWARICH_MAX_ENTRIES = SOURCE_TAR_LIMITS.maxEntries;
export const DAWARICH_MAX_ENTRY_BYTES = SOURCE_TAR_LIMITS.maxEntryBytes;
export const DAWARICH_MAX_TOTAL_BYTES = SOURCE_TAR_LIMITS.maxTotalBytes;
export const DAWARICH_MAX_MANIFEST_BYTES = SOURCE_TAR_LIMITS.maxManifestBytes;
export class DawarichSourcePartError extends Error {
  constructor(readonly code: SourceTarErrorCode | "manifest_mismatch") {
    super(code);
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
): Promise<{ entries: ParsedDawarichEntry[]; stream: DawarichTarStreamSummary }> {
  const bounded = {
    maxEntries: limits.maxEntries ?? DAWARICH_MAX_ENTRIES,
    maxEntryBytes: limits.maxEntryBytes ?? DAWARICH_MAX_ENTRY_BYTES,
    maxTotalBytes: limits.maxTotalBytes ?? DAWARICH_MAX_TOTAL_BYTES,
  };
  const entries: ParsedDawarichEntry[] = [];
  const seen = new Set<DawarichSourceEntryId>();
  const observed = new Map<DawarichSourceEntryId, { bytes: number; sha256: string }>();
  let total = 0;
  let sawManifest = false;
  let manifest: DawarichSourceManifestV1 | undefined;
  const reader = new SourceTarReader(input, bounded, (code) => new DawarichSourcePartError(code));
  await reader.read(async ({ path, bytes: size, content: body }) => {
    if (sawManifest) throw new DawarichSourcePartError("manifest_mismatch");
    const id = dawarichEntryIdForPath(path);
    if (!id) throw new DawarichSourcePartError("unsafe_path");
    if (seen.has(id)) throw new DawarichSourcePartError("duplicate");
    if (id === "source-manifest" && size > DAWARICH_MAX_MANIFEST_BYTES)
      throw new DawarichSourcePartError("limit_exceeded");
    let content: Buffer | undefined;
    const hash = createHash("sha256");
    let consumed = 0;
    const captured: Buffer[] = [];
    const memberContent = (async function* () {
      for await (const chunk of body) {
        consumed += chunk.byteLength;
        hash.update(chunk);
        if (collect || id === "source-manifest") captured.push(Buffer.from(chunk));
        yield chunk;
      }
    })();
    if (onEntry) await onEntry({ id, path, bytes: size, content: memberContent });
    else
      for await (const _chunk of memberContent) {
        /* Collect the bounded member. */
      }
    if (consumed !== size) throw new DawarichSourcePartError("truncated");
    if (collect || id === "source-manifest") content = Buffer.concat(captured, size);
    const sha256 = hash.digest("hex");
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
  });
  if (!seen.size) throw new DawarichSourcePartError("truncated");
  if (!manifest) throw new DawarichSourcePartError("manifest_mismatch");
  validateObservedManifest(manifest, observed);
  return { entries, stream: { entryIds: [...seen], totalBytes: total, manifest } };
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
  return result.stream;
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
  let spool: EncryptedSourceSpool | undefined;
  const entries: CollectorSourcePartEntry[] = [];
  try {
    await parseDawarichTarStream(
      input,
      async (entry) => {
        spool ??= await EncryptedSourceSpool.create({
          parentDirectory: options.spoolParentDirectory,
        });
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
    if (!spool) throw new DawarichSourcePartError("manifest_mismatch");
    const completedSpool = spool;
    return { entries, dispose: () => completedSpool.dispose() };
  } catch (error) {
    await spool?.dispose();
    throw error;
  }
}
