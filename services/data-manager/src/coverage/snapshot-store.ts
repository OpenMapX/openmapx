import { randomUUID } from "node:crypto";
import type { StreamEvidence } from "@openmapx/core/coverage";
import type { DataManagerCoveragePage, DataManagerCoverageSnapshot } from "./types.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_REVISIONS = 4;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

export interface CoverageSnapshotStoreOptions {
  collect: () => Promise<DataManagerCoverageSnapshot>;
  now?: () => number;
  ttlMs?: number;
  maxRevisions?: number;
  maxBytes?: number;
}

interface StoredRevision {
  snapshot: DataManagerCoverageSnapshot;
  expiresAt: number;
  bytes: number;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return value;
}

function boundedOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 10_000_000) {
    throw new Error("offset must be a non-negative integer");
  }
  return value;
}

function addTruncationWarning(warnings: DataManagerCoverageSnapshot["warnings"]): void {
  if (!warnings.includes("evidence_truncated")) warnings.push("evidence_truncated");
}

/**
 * Keeps a small immutable in-process revision for data-manager pagination.
 * Collection is intentionally injected so tests can prove that reads do not
 * mutate the source inventory and production can keep all filesystem/SQL
 * access behind the collector boundary.
 */
export class CoverageSnapshotStore {
  private readonly collect: CoverageSnapshotStoreOptions["collect"];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRevisions: number;
  private readonly maxBytes: number;
  private readonly revisions = new Map<string, StoredRevision>();
  private inFlight: Promise<DataManagerCoverageSnapshot> | null = null;
  private revisionInFlight: Promise<DataManagerCoverageSnapshot> | null = null;

  constructor(options: CoverageSnapshotStoreOptions) {
    this.collect = options.collect;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRevisions = options.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    this.maxBytes = (options.maxBytes ?? DEFAULT_MAX_BYTES) - 256;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, revision] of this.revisions) {
      if (revision.expiresAt <= now) this.revisions.delete(id);
    }
  }

  private retainBounded(snapshot: DataManagerCoverageSnapshot): DataManagerCoverageSnapshot {
    const streams = [...snapshot.streams]
      .slice(0, 10000)
      .sort((a, b) => a.key.localeCompare(b.key));
    const allRights = [...(snapshot.rights ?? [])].sort((a, b) => a.key.localeCompare(b.key));
    const rights = allRights.slice(0, 10_000);
    const rightsTruncated = rights.length < allRights.length;
    const totalStreams = Math.max(snapshot.totalStreams, snapshot.streams.length);
    const result: DataManagerCoverageSnapshot = {
      ...snapshot,
      streams,
      rights,
      totalStreams,
      truncated: snapshot.truncated || streams.length < totalStreams || rightsTruncated,
      warnings: [...snapshot.warnings],
    };

    if (result.truncated) addTruncationWarning(result.warnings);
    if (rightsTruncated) {
      result.collectionStatus =
        result.collectionStatus === "unavailable" ? "unavailable" : "partial";
    }
    if (byteLength(result) <= this.maxBytes) return result;

    // Region metadata is part of every page, even an empty source page.
    // Bound it as well so trimming source rows cannot leave an oversized envelope.
    while (
      byteLength({ ...result, streams: [], rights: [] }) > this.maxBytes &&
      result.regions.length > 0
    ) {
      result.regions = result.regions.slice(0, Math.floor(result.regions.length / 2));
      result.truncated = true;
      result.collectionStatus = "partial";
    }
    addTruncationWarning(result.warnings);

    // Rights are part of the envelope too. Trim them before source rows so a
    // large active transit manifest cannot make the page exceed its byte
    // ceiling while retaining an apparently complete permission list.
    let rightsLow = 0;
    let rightsHigh = rights.length;
    let bestRights: typeof rights = [];
    while (rightsLow <= rightsHigh) {
      const middle = Math.floor((rightsLow + rightsHigh) / 2);
      const probe: DataManagerCoverageSnapshot = {
        ...result,
        rights: rights.slice(0, middle),
        truncated: true,
        warnings: [...result.warnings],
      };
      addTruncationWarning(probe.warnings);
      if (byteLength(probe) <= this.maxBytes) {
        bestRights = rights.slice(0, middle);
        rightsLow = middle + 1;
      } else {
        rightsHigh = middle - 1;
      }
    }
    result.rights = bestRights;
    if (bestRights.length < rights.length) {
      result.truncated = true;
      result.collectionStatus =
        result.collectionStatus === "unavailable" ? "unavailable" : "partial";
    }
    if (result.truncated) addTruncationWarning(result.warnings);
    if (byteLength(result) <= this.maxBytes) return result;

    // Remove source rows from the end until the complete envelope fits. The
    // binary search keeps collection bounded even when a deployment has many
    // registered feeds. The original total remains in `totalStreams` so the
    // caller cannot mistake a size ceiling for a complete inventory.
    let low = 0;
    let high = streams.length;
    let best: StreamEvidence[] = [];
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = streams.slice(0, middle);
      const probe: DataManagerCoverageSnapshot = {
        ...result,
        streams: candidate,
        totalStreams,
        truncated: true,
        warnings: [...result.warnings],
      };
      addTruncationWarning(probe.warnings);
      if (byteLength(probe) <= this.maxBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    result.streams = best;
    result.truncated = true;
    result.collectionStatus = result.collectionStatus === "unavailable" ? "unavailable" : "partial";
    addTruncationWarning(result.warnings);
    if (byteLength(result) > this.maxBytes)
      throw new Error("coverage envelope exceeds retention limit");
    return result;
  }

  private async createRevision(): Promise<DataManagerCoverageSnapshot> {
    if (!this.inFlight) {
      this.inFlight = this.collect().finally(() => {
        this.inFlight = null;
      });
    }
    const collected = await this.inFlight;
    const bounded = this.retainBounded(collected);
    const snapshot: DataManagerCoverageSnapshot = {
      ...bounded,
      snapshotId: randomUUID(),
    };
    this.evictExpired();
    this.revisions.set(snapshot.snapshotId, {
      snapshot,
      expiresAt: this.now() + this.ttlMs,
      bytes: byteLength(snapshot),
    });
    while (this.revisions.size > this.maxRevisions) {
      const oldest = this.revisions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.revisions.delete(oldest);
    }
    return snapshot;
  }

  private collectRevision(): Promise<DataManagerCoverageSnapshot> {
    this.revisionInFlight ??= this.createRevision().finally(() => {
      this.revisionInFlight = null;
    });
    return this.revisionInFlight;
  }

  async latest(): Promise<DataManagerCoverageSnapshot> {
    this.evictExpired();
    const newest = [...this.revisions.values()].at(-1)?.snapshot;
    return newest ?? this.collectRevision();
  }

  get(snapshotId: string): DataManagerCoverageSnapshot | null {
    this.evictExpired();
    const revision = this.revisions.get(snapshotId);
    return revision?.snapshot ?? null;
  }

  page(
    snapshot: DataManagerCoverageSnapshot,
    options: { offset?: number; limit?: number } = {},
  ): DataManagerCoveragePage {
    const offset = boundedOffset(options.offset);
    const limit = boundedLimit(options.limit);
    const evaluatedAt = new Date(this.now()).toISOString();
    const evidence = snapshot.streams.slice(offset, offset + limit);
    return {
      schemaVersion: 1,
      snapshotId: snapshot.snapshotId,
      generatedAt: snapshot.generatedAt,
      evaluatedAt,
      collectionStatus: snapshot.collectionStatus,
      authorities: snapshot.authorities,
      warnings: snapshot.warnings,
      regions: snapshot.regions,
      evidence,
      rights: snapshot.rights ?? [],
      total: snapshot.totalStreams,
      retainedTotal: snapshot.streams.length,
      truncated: snapshot.truncated,
      unassignedSourceCount: snapshot.unassignedSourceCount,
      pagination: {
        offset,
        limit,
        total: snapshot.totalStreams,
        hasMore: offset + evidence.length < snapshot.streams.length,
        snapshotId: snapshot.snapshotId,
      },
    };
  }

  stats(): { revisions: number; bytes: number } {
    this.evictExpired();
    return {
      revisions: this.revisions.size,
      bytes: [...this.revisions.values()].reduce((total, revision) => total + revision.bytes, 0),
    };
  }
}

export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT };
