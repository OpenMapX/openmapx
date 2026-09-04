import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { ZipArchive } from "@archiver/archiver";
import { type DawarichSourceEntryId, dawarichSourcePathForEntryId } from "@openmapx/core/privacy";
import type { EncryptedBlobResult, EncryptedBlobStore } from "./artifact-storage.js";
import { isBackupOpenmapxEntryId } from "./backup-source-part.js";

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
  "backup-record-schema": "openmapx-data-export/schemas/backup-history-record.schema.json",
  "backup-source-schema": "openmapx-data-export/schemas/backup-source.schema.json",
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
  "backup-dawarich-source-manifest":
    "openmapx-data-export/article-15/history/dawarich/source-manifest.json",
  "backup-dawarich-account": "openmapx-data-export/article-15/history/dawarich/account.json",
  "backup-dawarich-settings": "openmapx-data-export/article-15/history/dawarich/settings.json",
  "backup-dawarich-areas": "openmapx-data-export/article-15/history/dawarich/areas.jsonl",
  "backup-dawarich-places": "openmapx-data-export/article-15/history/dawarich/places.jsonl",
  "backup-dawarich-tags": "openmapx-data-export/article-15/history/dawarich/tags.jsonl",
  "backup-dawarich-taggings": "openmapx-data-export/article-15/history/dawarich/taggings.jsonl",
  "backup-dawarich-imports": "openmapx-data-export/article-15/history/dawarich/imports.jsonl",
  "backup-dawarich-export-records":
    "openmapx-data-export/article-15/history/dawarich/export-records.jsonl",
  "backup-dawarich-trips": "openmapx-data-export/article-15/history/dawarich/trips.jsonl",
  "backup-dawarich-notifications":
    "openmapx-data-export/article-15/history/dawarich/notifications.jsonl",
  "backup-dawarich-points": "openmapx-data-export/article-15/history/dawarich/points.jsonl",
  "backup-dawarich-visits": "openmapx-data-export/article-15/history/dawarich/visits.jsonl",
  "backup-dawarich-stats": "openmapx-data-export/article-15/history/dawarich/stats.jsonl",
  "backup-dawarich-tracks": "openmapx-data-export/article-15/history/dawarich/tracks.jsonl",
  "backup-dawarich-track-segments":
    "openmapx-data-export/article-15/history/dawarich/track-segments.jsonl",
  "backup-dawarich-digests": "openmapx-data-export/article-15/history/dawarich/digests.jsonl",
  "backup-dawarich-raw-archives":
    "openmapx-data-export/article-15/history/dawarich/raw-archives.jsonl",
  "backup-dawarich-flights": "openmapx-data-export/article-15/history/dawarich/flights.jsonl",
  "backup-dawarich-notes": "openmapx-data-export/article-15/history/dawarich/notes.jsonl",
  "backup-dawarich-posters": "openmapx-data-export/article-15/history/dawarich/posters.jsonl",
  "backup-dawarich-shared-links":
    "openmapx-data-export/article-15/history/dawarich/shared-links.jsonl",
  "backup-dawarich-attachments":
    "openmapx-data-export/article-15/history/dawarich/attachments.jsonl",
  "backup-dawarich-rich-text": "openmapx-data-export/article-15/history/dawarich/rich-text.jsonl",
  "backup-dawarich-family": "openmapx-data-export/article-15/history/dawarich/family.jsonl",
  "backup-dawarich-portable-areas": "openmapx-data-export/portable/history/dawarich/areas.jsonl",
  "backup-dawarich-portable-places": "openmapx-data-export/portable/history/dawarich/places.jsonl",
  "backup-dawarich-portable-imports":
    "openmapx-data-export/portable/history/dawarich/imports.jsonl",
  "backup-dawarich-portable-points": "openmapx-data-export/portable/history/dawarich/points.jsonl",
  "backup-dawarich-portable-raw-archives":
    "openmapx-data-export/portable/history/dawarich/raw-archives.jsonl",
  "backup-dawarich-portable-flights":
    "openmapx-data-export/portable/history/dawarich/flights.jsonl",
  "backup-dawarich-portable-notes": "openmapx-data-export/portable/history/dawarich/notes.jsonl",
  "backup-source-metadata": "openmapx-data-export/article-15/history/backup-source.json",
  "backup-source-manifest": "openmapx-data-export/article-15/history/source-manifest.json",
  "supplements-manifest": "openmapx-data-export/article-15/supplements/manifest.json",
  "supplement-1": "openmapx-data-export/article-15/supplements/1.bin",
  "supplement-2": "openmapx-data-export/article-15/supplements/2.bin",
  "supplement-3": "openmapx-data-export/article-15/supplements/3.bin",
  "supplement-4": "openmapx-data-export/article-15/supplements/4.bin",
  "supplement-5": "openmapx-data-export/article-15/supplements/5.bin",
  "supplement-6": "openmapx-data-export/article-15/supplements/6.bin",
  "supplement-7": "openmapx-data-export/article-15/supplements/7.bin",
  "supplement-8": "openmapx-data-export/article-15/supplements/8.bin",
  "supplement-9": "openmapx-data-export/article-15/supplements/9.bin",
  "supplement-10": "openmapx-data-export/article-15/supplements/10.bin",
  "supplement-11": "openmapx-data-export/article-15/supplements/11.bin",
  "supplement-12": "openmapx-data-export/article-15/supplements/12.bin",
  "supplement-13": "openmapx-data-export/article-15/supplements/13.bin",
  "supplement-14": "openmapx-data-export/article-15/supplements/14.bin",
  "supplement-15": "openmapx-data-export/article-15/supplements/15.bin",
  "supplement-16": "openmapx-data-export/article-15/supplements/16.bin",
  "supplement-17": "openmapx-data-export/article-15/supplements/17.bin",
  "supplement-18": "openmapx-data-export/article-15/supplements/18.bin",
  "supplement-19": "openmapx-data-export/article-15/supplements/19.bin",
  "supplement-20": "openmapx-data-export/article-15/supplements/20.bin",
  "supplement-21": "openmapx-data-export/article-15/supplements/21.bin",
  "supplement-22": "openmapx-data-export/article-15/supplements/22.bin",
  "supplement-23": "openmapx-data-export/article-15/supplements/23.bin",
  "supplement-24": "openmapx-data-export/article-15/supplements/24.bin",
  "supplement-25": "openmapx-data-export/article-15/supplements/25.bin",
  "supplement-26": "openmapx-data-export/article-15/supplements/26.bin",
  "supplement-27": "openmapx-data-export/article-15/supplements/27.bin",
  "supplement-28": "openmapx-data-export/article-15/supplements/28.bin",
  "supplement-29": "openmapx-data-export/article-15/supplements/29.bin",
  "supplement-30": "openmapx-data-export/article-15/supplements/30.bin",
  "supplement-31": "openmapx-data-export/article-15/supplements/31.bin",
  "supplement-32": "openmapx-data-export/article-15/supplements/32.bin",
} as const);

export type ArchiveLogicalId = keyof typeof ARCHIVE_PATHS | string;

const DYNAMIC_DAWARICH_PREFIXES = [
  { logicalPrefix: "dawarich-", archivePrefix: "openmapx-data-export/article-15/timeline/" },
  { logicalPrefix: "backup-dawarich-", archivePrefix: "openmapx-data-export/article-15/history/" },
  { logicalPrefix: "dawarich-portable-", archivePrefix: "openmapx-data-export/portable/timeline/" },
  {
    logicalPrefix: "backup-dawarich-portable-",
    archivePrefix: "openmapx-data-export/portable/history/",
  },
] as const;

/** Return the only archive path permitted for a logical member. Dynamic
 * Dawarich members retain the source contract's reviewed relative path while
 * selecting a fixed Article 15/20 namespace. */
export function archivePathForLogicalId(logicalId: string): string | null {
  const fixed = ARCHIVE_PATHS[logicalId as keyof typeof ARCHIVE_PATHS];
  if (fixed) return fixed;
  const retained = /^backup-([a-f0-9]{64})-(.+)$/.exec(logicalId);
  if (retained) {
    const [, reference, member] = retained;
    const articleRoot = `openmapx-data-export/article-15/history/${reference}`;
    const portableRoot = `openmapx-data-export/portable/history/${reference}`;
    if (member === "source-metadata") return `${articleRoot}/backup-source.json`;
    if (member === "source-manifest") return `${articleRoot}/source-manifest.json`;
    if (member.startsWith("openmapx-portable-")) {
      const id = member.slice("openmapx-portable-".length);
      if (isBackupOpenmapxEntryId(id)) return `${portableRoot}/openmapx/${id}.jsonl`;
    }
    if (member.startsWith("openmapx-")) {
      const id = member.slice("openmapx-".length);
      if (isBackupOpenmapxEntryId(id)) return `${articleRoot}/openmapx/${id}.jsonl`;
    }
    for (const [prefix, root] of [
      ["dawarich-portable-", portableRoot],
      ["dawarich-", articleRoot],
    ] as const) {
      if (!member.startsWith(prefix)) continue;
      const sourcePath = dawarichSourcePathForEntryId(
        member.slice(prefix.length) as DawarichSourceEntryId,
      );
      if (sourcePath) return `${root}/${sourcePath}`;
    }
    return null;
  }
  for (const { logicalPrefix, archivePrefix } of DYNAMIC_DAWARICH_PREFIXES) {
    if (!logicalId.startsWith(logicalPrefix)) continue;
    const sourceId = logicalId.slice(logicalPrefix.length) as DawarichSourceEntryId;
    const sourcePath = dawarichSourcePathForEntryId(sourceId);
    if (sourcePath) return `${archivePrefix}${sourcePath}`;
  }
  const primaryPortablePrefix = "backup-openmapx-portable-";
  const primaryPrefix = "backup-openmapx-";
  if (logicalId.startsWith(primaryPortablePrefix)) {
    const id = logicalId.slice(primaryPortablePrefix.length);
    if (isBackupOpenmapxEntryId(id))
      return `openmapx-data-export/portable/history/openmapx/${id}.jsonl`;
  }
  if (logicalId.startsWith(primaryPrefix)) {
    const id = logicalId.slice(primaryPrefix.length);
    if (isBackupOpenmapxEntryId(id))
      return `openmapx-data-export/article-15/history/openmapx/${id}.jsonl`;
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

export interface ArchiveWriteResult extends EncryptedBlobResult {
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

/** Fixed-name ZIP64 archive facade; caller-supplied paths are never accepted. */
export class PrivacyArchiveWriter {
  constructor(private readonly store: EncryptedBlobStore) {}

  async writeArchive(input: {
    requestId: string;
    artifactId: string;
    entries: ArchiveEntryInput[];
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
    // Start the ZIP queue and encrypted sink together.  Per-entry facts are
    // resolved as each source is consumed, so a large stream is never copied
    // into an intermediate plaintext buffer.
    const writePromise = this.store.write({
      requestId: input.requestId,
      blobId: input.artifactId,
      purpose: "export-artifact",
      storageKey: `objects/${input.artifactId}.bin`,
      source: archive,
      maxBytes: input.maxBytes ?? MAX_ARCHIVE_BYTES,
    });
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
      // Observe sink/finalizer failures while sources are still streaming.
      // Waiting for source facts first deadlocks when a failed sink stops reading.
      const [result, , facts] = await Promise.all([writePromise, finalizePromise, factsPromise]);
      if (!result) throw new Error("Privacy archive write failed");
      return { ...result, entries: facts };
    } catch (error) {
      archive.destroy(error as Error);
      for (const { tracked: source } of tracked) {
        if (source.source instanceof Readable) source.source.destroy();
      }
      // Archiver may leave finalize pending after destroy; only the encrypted
      // writer owns physical cleanup that must finish before returning.
      await Promise.allSettled([writePromise]);
      throw error;
    }
  }
}
