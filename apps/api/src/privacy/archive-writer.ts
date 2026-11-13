import { createHash } from "node:crypto";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "@archiver/archiver";
import { type DawarichSourceEntryId, dawarichSourcePathForEntryId } from "@openmapx/core/privacy";

export const ARCHIVE_PATHS = Object.freeze({
  "readme-html": "openmapx-data-export/README.html",
  "readme-text": "openmapx-data-export/README.txt",
  manifest: "openmapx-data-export/manifest.json",
  "processing-information": "openmapx-data-export/article-15/processing-information.json",
  account: "openmapx-data-export/article-15/account.json",
  authentication: "openmapx-data-export/article-15/authentication-and-security.json",
  "saved-content": "openmapx-data-export/article-15/saved-content.jsonl",
  vehicles: "openmapx-data-export/article-15/vehicles-and-parking.jsonl",
  sharing: "openmapx-data-export/article-15/sharing.jsonl",
  "timeline-connections": "openmapx-data-export/article-15/timeline/connections.jsonl",
  activity: "openmapx-data-export/article-15/activity-and-audit.jsonl",
  disclosures: "openmapx-data-export/article-15/disclosures.jsonl",
  requests: "openmapx-data-export/article-15/requests.jsonl",
  other: "openmapx-data-export/article-15/other-processing.jsonl",
  profile: "openmapx-data-export/portable/profile.json",
  "portable-lists": "openmapx-data-export/portable/saved-lists.json",
  "portable-places": "openmapx-data-export/portable/saved-places.geojson",
  "portable-vehicles": "openmapx-data-export/portable/vehicles.json",
  "portable-parking": "openmapx-data-export/portable/parking.geojson",
  preferences: "openmapx-data-export/portable/preferences.json",
  "manifest-schema": "openmapx-data-export/schemas/export-manifest.schema.json",
  "category-schema": "openmapx-data-export/schemas/category-manifest.schema.json",
  "export-record-schema": "openmapx-data-export/schemas/export-record.schema.json",
  "portable-profile-schema": "openmapx-data-export/schemas/portable-profile.schema.json",
  "portable-places-schema": "openmapx-data-export/schemas/portable-places.schema.json",
  "processing-information-schema":
    "openmapx-data-export/schemas/processing-information.schema.json",
  "dawarich-source-manifest":
    "openmapx-data-export/article-15/timeline/dawarich/source-manifest.json",
  "dawarich-account": "openmapx-data-export/article-15/timeline/dawarich/account.json",
  "dawarich-settings": "openmapx-data-export/article-15/timeline/dawarich/settings.json",
  "dawarich-areas": "openmapx-data-export/article-15/timeline/dawarich/areas.jsonl",
  "dawarich-places": "openmapx-data-export/article-15/timeline/dawarich/places.jsonl",
  "dawarich-tags": "openmapx-data-export/article-15/timeline/dawarich/tags.jsonl",
  "dawarich-taggings": "openmapx-data-export/article-15/timeline/dawarich/taggings.jsonl",
  "dawarich-imports": "openmapx-data-export/article-15/timeline/dawarich/imports.jsonl",
  "dawarich-export-records":
    "openmapx-data-export/article-15/timeline/dawarich/export-records.jsonl",
  "dawarich-trips": "openmapx-data-export/article-15/timeline/dawarich/trips.jsonl",
  "dawarich-notifications": "openmapx-data-export/article-15/timeline/dawarich/notifications.jsonl",
  "dawarich-points": "openmapx-data-export/article-15/timeline/dawarich/points.jsonl",
  "dawarich-visits": "openmapx-data-export/article-15/timeline/dawarich/visits.jsonl",
  "dawarich-stats": "openmapx-data-export/article-15/timeline/dawarich/stats.jsonl",
  "dawarich-tracks": "openmapx-data-export/article-15/timeline/dawarich/tracks.jsonl",
  "dawarich-track-segments":
    "openmapx-data-export/article-15/timeline/dawarich/track-segments.jsonl",
  "dawarich-digests": "openmapx-data-export/article-15/timeline/dawarich/digests.jsonl",
  "dawarich-raw-archives": "openmapx-data-export/article-15/timeline/dawarich/raw-archives.jsonl",
  "dawarich-flights": "openmapx-data-export/article-15/timeline/dawarich/flights.jsonl",
  "dawarich-notes": "openmapx-data-export/article-15/timeline/dawarich/notes.jsonl",
  "dawarich-posters": "openmapx-data-export/article-15/timeline/dawarich/posters.jsonl",
  "dawarich-shared-links": "openmapx-data-export/article-15/timeline/dawarich/shared-links.jsonl",
  "dawarich-attachments": "openmapx-data-export/article-15/timeline/dawarich/attachments.jsonl",
  "dawarich-rich-text": "openmapx-data-export/article-15/timeline/dawarich/rich-text.jsonl",
  "dawarich-family": "openmapx-data-export/article-15/timeline/dawarich/family.jsonl",
  "dawarich-portable-areas": "openmapx-data-export/portable/timeline/dawarich/areas.jsonl",
  "dawarich-portable-places": "openmapx-data-export/portable/timeline/dawarich/places.jsonl",
  "dawarich-portable-imports": "openmapx-data-export/portable/timeline/dawarich/imports.jsonl",
  "dawarich-portable-points": "openmapx-data-export/portable/timeline/dawarich/points.jsonl",
  "dawarich-portable-raw-archives":
    "openmapx-data-export/portable/timeline/dawarich/raw-archives.jsonl",
  "dawarich-portable-flights": "openmapx-data-export/portable/timeline/dawarich/flights.jsonl",
  "dawarich-portable-notes": "openmapx-data-export/portable/timeline/dawarich/notes.jsonl",
} as const);

export type ArchiveLogicalId = keyof typeof ARCHIVE_PATHS | string;

const DYNAMIC_DAWARICH_PREFIXES = [
  { logicalPrefix: "dawarich-", archivePrefix: "openmapx-data-export/article-15/timeline/" },
  { logicalPrefix: "dawarich-portable-", archivePrefix: "openmapx-data-export/portable/timeline/" },
] as const;

/** Return the only archive path permitted for a logical member. Dynamic
 * Dawarich members retain the source contract's reviewed relative path while
 * selecting a fixed Article 15/20 namespace. */
export function archivePathForLogicalId(logicalId: string): string | null {
  const fixed = ARCHIVE_PATHS[logicalId as keyof typeof ARCHIVE_PATHS];
  if (fixed) return fixed;
  for (const { logicalPrefix, archivePrefix } of DYNAMIC_DAWARICH_PREFIXES) {
    if (!logicalId.startsWith(logicalPrefix)) continue;
    const sourceId = logicalId.slice(logicalPrefix.length) as DawarichSourceEntryId;
    const sourcePath = dawarichSourcePathForEntryId(sourceId);
    if (sourcePath) return `${archivePrefix}${sourcePath}`;
  }
  return null;
}

export interface ArchiveEntryInput {
  logicalId: ArchiveLogicalId | string;
  source: Buffer | string | Readable | AsyncIterable<Uint8Array>;
  mediaType?: string;
  bytes?: number;
  sha256?: string;
  recordCount?: number;
  schemaId?: string;
}

export interface ArchiveEntryResult {
  logicalId: string;
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  recordCount: number | null;
  schemaId: string | null;
}

export interface ArchiveWriteResult {
  entries: ArchiveEntryResult[];
}

const MAX_ENTRIES = 512;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

function sourceReadable(source: ArchiveEntryInput["source"]): Readable | Buffer {
  if (Buffer.isBuffer(source)) return source;
  if (typeof source === "string") return Buffer.from(source, "utf8");
  if (source instanceof Readable) return source;
  return Readable.from(source);
}

interface TrackedSource {
  source: Readable | Buffer;
  facts: Promise<{ bytes: number; sha256: string }>;
}

function trackedSource(
  source: ArchiveEntryInput["source"],
  expected: { bytes?: number; sha256?: string },
  maxBytes: number,
  total: { value: number },
): TrackedSource {
  const readable = sourceReadable(source);
  if (Buffer.isBuffer(readable)) {
    const bytes = readable.byteLength;
    const sha256 = createHash("sha256").update(readable).digest("hex");
    if (bytes > maxBytes || total.value + bytes > maxBytes)
      throw new Error("Privacy archive entry exceeds size limit");
    if (expected.bytes !== undefined && expected.bytes !== bytes)
      throw new Error("Privacy archive entry byte count mismatch");
    if (expected.sha256 !== undefined && expected.sha256 !== sha256)
      throw new Error("Privacy archive entry digest mismatch");
    total.value += bytes;
    return { source: readable, facts: Promise.resolve({ bytes, sha256 }) };
  }
  let resolveFacts!: (value: { bytes: number; sha256: string }) => void;
  let rejectFacts!: (error: unknown) => void;
  const facts = new Promise<{ bytes: number; sha256: string }>((resolve, reject) => {
    resolveFacts = resolve;
    rejectFacts = reject;
  });
  void facts.catch(() => undefined);
  const hash = createHash("sha256");
  let bytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      // Account for every chunk as it arrives.  Multiple stream sources are
      // piped into the archive concurrently; waiting until each stream's
      // `flush` would let their in-flight totals exceed the aggregate bound.
      if (bytes > maxBytes || total.value + value.byteLength > maxBytes) {
        callback(new Error("Privacy archive entry exceeds size limit"));
        return;
      }
      total.value += value.byteLength;
      hash.update(value);
      callback(null, value);
    },
    flush(callback) {
      const sha256 = hash.digest("hex");
      if (expected.bytes !== undefined && expected.bytes !== bytes) {
        const error = new Error("Privacy archive entry byte count mismatch");
        rejectFacts(error);
        callback(error);
        return;
      }
      if (expected.sha256 !== undefined && expected.sha256 !== sha256) {
        const error = new Error("Privacy archive entry digest mismatch");
        rejectFacts(error);
        callback(error);
        return;
      }
      resolveFacts({ bytes, sha256 });
      callback();
    },
  });
  const fail = (error: unknown) => rejectFacts(error);
  readable.once("error", fail);
  transform.once("error", fail);
  transform.once("close", () => {
    readable.unpipe(transform);
    readable.destroy();
    rejectFacts(new Error("Privacy archive source closed"));
  });
  readable.pipe(transform);
  return { source: transform, facts };
}

/** Fixed-name ZIP64 archive facade; caller-supplied paths are never accepted.
 * The archive streams straight into the sink (the HTTP response for a
 * download), so no archive copy is written to disk. */
export class PrivacyArchiveWriter {
  async writeArchive(input: {
    entries: ArchiveEntryInput[];
    sink: Writable;
    maxBytes?: number;
  }): Promise<ArchiveWriteResult> {
    if (input.entries.length < 1 || input.entries.length > MAX_ENTRIES)
      throw new Error("Invalid archive entry count");
    const seen = new Set<string>();
    const normalized = input.entries.map((entry) => {
      const path = archivePathForLogicalId(entry.logicalId);
      if (!path) throw new Error(`Archive entry is not registered: ${entry.logicalId}`);
      const logicalId = entry.logicalId;
      if (seen.has(logicalId)) throw new Error(`Archive duplicate entry: ${logicalId}`);
      seen.add(logicalId);
      return { ...entry, logicalId, path };
    });
    const archive = new ZipArchive({
      forceZip64: true,
      forceUTC: true,
      highWaterMark: 64 * 1024,
      statConcurrency: 1,
      zlib: { level: 6 },
    });
    const total = { value: 0 };
    const tracked: Array<{ entry: (typeof normalized)[number]; tracked: TrackedSource }> = [];
    try {
      for (const entry of normalized) {
        tracked.push({
          entry,
          tracked: trackedSource(
            entry.source,
            { bytes: entry.bytes, sha256: entry.sha256 },
            input.maxBytes ?? MAX_ARCHIVE_BYTES,
            total,
          ),
        });
      }
    } catch (error) {
      for (const { tracked: source } of tracked) {
        if (source.source instanceof Readable) source.source.destroy();
      }
      archive.destroy();
      throw error;
    }
    for (const { entry, tracked: source } of tracked) {
      archive.append(source.source, {
        name: entry.path,
        date: new Date("1980-01-01T00:00:00.000Z"),
        mode: 0o600,
      });
    }
    // Start the ZIP queue and the sink together. Per-entry facts resolve as
    // each source is consumed, so a large stream is never buffered whole.
    const writePromise = pipeline(archive, input.sink);
    const finalizePromise = archive.finalize();
    try {
      const factsPromise = Promise.all(
        tracked.map(async ({ entry, tracked: source }) => {
          const resolved = await source.facts;
          return {
            logicalId: entry.logicalId,
            path: entry.path,
            bytes: resolved.bytes,
            sha256: resolved.sha256,
            mediaType: entry.mediaType ?? "application/octet-stream",
            recordCount: entry.recordCount ?? null,
            schemaId: entry.schemaId ?? null,
          };
        }),
      );
      // Observe sink and finalizer failures while sources are still streaming.
      // Waiting for source facts first deadlocks when a failed sink stops reading.
      const [, , facts] = await Promise.all([writePromise, finalizePromise, factsPromise]);
      return { entries: facts };
    } catch (error) {
      archive.destroy(error as Error);
      for (const { tracked: source } of tracked) {
        if (source.source instanceof Readable) source.source.destroy();
      }
      await Promise.allSettled([writePromise]);
      throw error;
    }
  }
}
