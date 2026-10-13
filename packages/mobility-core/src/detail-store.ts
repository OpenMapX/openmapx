import { randomUUID } from "node:crypto";
import type { CacheClient } from "./cache.js";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types/shared-mobility.js";

export type SharedMobilityDetailItem = SharedMobilityStation | SharedMobilityVehicle;

/** The immutable acquisition identity and deadline of an inventory record. */
export interface RetainedSharedMobilityDetail {
  readonly item: SharedMobilityDetailItem;
  readonly acquisitionToken: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

interface DetailSnapshot {
  schemaVersion: 2;
  items: RetainedSharedMobilityDetail[];
}

const PROVIDER_SCOPED_PREFIXES = new Set([
  "de-cambio",
  "citybikes",
  "db-bike",
  "gbfs",
  "nextbike",
  "de-nw-mobidrom-scooter",
]);

function decodeProviderScopedMotisId(id: string): {
  origin: "motis-local" | "transitous";
  providerId: string;
} | null {
  const [origin, provider, kind, nativeId, ...extra] = id.split("/");
  if (origin !== "motis-local" && origin !== "transitous") return null;
  if (!provider || !kind || !nativeId || extra.length > 0) return null;
  try {
    return { origin, providerId: decodeURIComponent(provider) };
  } catch {
    return null;
  }
}

function directScope(id: string): string | null {
  const [prefix, provider] = id.split("/");
  if (!prefix) return null;
  if (provider && PROVIDER_SCOPED_PREFIXES.has(prefix)) return `${prefix}/${provider}`;
  return prefix;
}

export function sharedMobilityDetailScope(id: string): string | null {
  const motis = decodeProviderScopedMotisId(id);
  if (motis) return `${motis.origin}/${motis.providerId}`;
  return directScope(id);
}

function cacheKey(scope: string): string {
  return `shared-mobility-detail:v2:${encodeURIComponent(scope)}`;
}

/**
 * Provider-scoped, cross-process detail snapshots with a bounded process L1.
 * Search performs one shared write per provider/source instead of one write per item.
 */
export class SharedMobilityDetailStore {
  private readonly l1 = new Map<string, RetainedSharedMobilityDetail>();
  private publicationGeneration = 0;
  private clearGeneration = 0;

  constructor(
    private readonly cache: CacheClient,
    private readonly ttlSeconds: number,
    private readonly maxL1Items: number,
    private readonly maxSnapshotItems = 10_000,
  ) {}

  clearL1(): void {
    this.publicationGeneration++;
    this.clearGeneration++;
    this.l1.clear();
  }

  private remember(record: RetainedSharedMobilityDetail): void {
    this.publicationGeneration++;
    this.l1.delete(record.item.id);
    this.l1.set(record.item.id, structuredClone(record));
    while (this.l1.size > this.maxL1Items) {
      const oldest = this.l1.keys().next().value;
      if (typeof oldest !== "string") break;
      this.l1.delete(oldest);
    }
  }

  private async readSnapshot(key: string): Promise<RetainedSharedMobilityDetail[]> {
    try {
      const snapshot = await this.cache.get<DetailSnapshot>(key);
      return snapshot?.schemaVersion === 2
        ? snapshot.items.filter((record) => record.expiresAt > Date.now())
        : [];
    } catch {
      return [];
    }
  }

  private async mergeAndStore(
    key: string,
    incoming: RetainedSharedMobilityDetail[],
  ): Promise<void> {
    try {
      const byId = new Map(
        (await this.readSnapshot(key)).map((record) => [record.item.id, record]),
      );
      for (const record of incoming) byId.set(record.item.id, record);
      const items = [...byId.values()].slice(-this.maxSnapshotItems);
      const remainingSeconds = Math.floor(
        (Math.max(...items.map((record) => record.expiresAt)) - Date.now()) / 1000,
      );
      if (remainingSeconds <= 0) return;
      await this.cache.set(
        key,
        { schemaVersion: 2, items } satisfies DetailSnapshot,
        remainingSeconds,
      );
    } catch {
      // Search remains available through bounded L1 when the shared cache is degraded.
    }
  }

  /** Only a new inventory acquisition establishes a new deadline/token. */
  async store(items: SharedMobilityDetailItem[]): Promise<void> {
    const byScope = new Map<string, RetainedSharedMobilityDetail[]>();
    const acquiredAt = Date.now();
    for (const item of items) {
      const record: RetainedSharedMobilityDetail = {
        item: structuredClone(item),
        acquisitionToken: randomUUID(),
        acquiredAt,
        expiresAt: acquiredAt + this.ttlSeconds * 1000,
      };
      this.remember(record);
      const scope = sharedMobilityDetailScope(item.id);
      if (scope) {
        const scoped = byScope.get(scope) ?? [];
        scoped.push(record);
        byScope.set(scope, scoped);
      }
    }
    await Promise.all(
      [...byScope].map(([scope, scoped]) => this.mergeAndStore(cacheKey(scope), scoped)),
    );
  }

  private patchKey(record: RetainedSharedMobilityDetail): string {
    return `shared-mobility-detail:enrichment:v1:${encodeURIComponent(record.item.id)}:${record.acquisitionToken}`;
  }

  /** Persist enrichment separately; an old read can never rewrite a newer inventory envelope. */
  async updateRetained(
    record: RetainedSharedMobilityDetail,
    item: SharedMobilityDetailItem,
  ): Promise<boolean> {
    if (
      item.id !== record.item.id ||
      record.expiresAt <= Date.now() ||
      JSON.stringify(item) === JSON.stringify(record.item)
    )
      return false;
    const remainingSeconds = Math.floor((record.expiresAt - Date.now()) / 1000);
    if (remainingSeconds <= 0) return false;
    const updated = { ...record, item: structuredClone(item) };
    try {
      await this.cache.set(this.patchKey(record), updated, remainingSeconds);
    } catch {
      // A degraded shared cache does not prevent this process retaining its bounded enrichment.
    }
    const current = this.l1.get(item.id);
    if (current?.acquisitionToken === record.acquisitionToken) this.remember(updated);
    return true;
  }

  async getRetained(id: string): Promise<RetainedSharedMobilityDetail | null> {
    const publicationGeneration = this.publicationGeneration;
    const clearGeneration = this.clearGeneration;
    let record = this.l1.get(id);
    if (record && record.expiresAt <= Date.now()) {
      this.l1.delete(id);
      record = undefined;
    }
    const initialRecord = record;
    // Only a replacement of this item or an explicit clear supersedes its read.
    // Unrelated L1 publications must not skip this acquisition's enrichment patch.
    const supersedingRecord = (): RetainedSharedMobilityDetail | null | undefined => {
      const current = this.l1.get(id);
      if (
        clearGeneration !== this.clearGeneration ||
        (current !== undefined && current !== initialRecord)
      )
        return current && current.expiresAt > Date.now() ? structuredClone(current) : null;
      return undefined;
    };
    if (!record) {
      const scope = sharedMobilityDetailScope(id);
      if (!scope) return null;
      record = (await this.readSnapshot(cacheKey(scope))).find(
        (candidate) => candidate.item.id === id,
      );
      const superseding = supersedingRecord();
      if (superseding !== undefined) return superseding;
    }
    if (!record) return null;
    try {
      const patch = await this.cache.get<RetainedSharedMobilityDetail>(this.patchKey(record));
      if (
        patch?.acquisitionToken === record.acquisitionToken &&
        patch.item.id === id &&
        patch.expiresAt === record.expiresAt &&
        patch.acquiredAt === record.acquiredAt &&
        patch.expiresAt > Date.now()
      )
        record = patch;
    } catch {
      /* Retained inventory still answers during cache failure. */
    }
    const superseding = supersedingRecord();
    if (superseding !== undefined) return superseding;
    if (record.expiresAt <= Date.now()) return null;
    // A replacement may already have been evicted while we awaited the cache.
    // Keep this conservative publication guard without interrupting a valid read:
    // no stale resurrection and no unbounded per-item generation history.
    if (publicationGeneration === this.publicationGeneration) this.remember(record);
    return structuredClone(record);
  }

  async get(id: string): Promise<SharedMobilityDetailItem | null> {
    return (await this.getRetained(id))?.item ?? null;
  }
}
