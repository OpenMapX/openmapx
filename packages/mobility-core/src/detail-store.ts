import type { CacheClient } from "./cache.js";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types/shared-mobility.js";

export type SharedMobilityDetailItem = SharedMobilityStation | SharedMobilityVehicle;

interface DetailSnapshot {
  schemaVersion: 1;
  items: SharedMobilityDetailItem[];
}

const PROVIDER_SCOPED_PREFIXES = new Set([
  "cambio",
  "citybikes",
  "db-bike",
  "gbfs",
  "nextbike",
  "nrw-mobidrom-scooter",
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

function decodeLegacyId(id: string): string | null {
  return id.startsWith("motis:") && id.length > 6 ? id.slice(6) : null;
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
  if (decodeLegacyId(id)) return null;
  return directScope(id);
}

function cacheKey(scope: string): string {
  return `shared-mobility-detail:v1:${encodeURIComponent(scope)}`;
}

function legacyCacheKey(origin: "motis-local" | "transitous"): string {
  return `shared-mobility-detail:v1:legacy:${origin}`;
}

/**
 * Provider-scoped, cross-process detail snapshots with a bounded process L1.
 * Search performs one shared write per provider/source instead of one write per item.
 */
export class SharedMobilityDetailStore {
  private cache: CacheClient | null = null;
  private readonly l1 = new Map<string, SharedMobilityDetailItem>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly maxL1Items: number,
    private readonly maxSnapshotItems = 10_000,
  ) {}

  setCache(cache: CacheClient): void {
    if (this.cache !== cache) this.clearL1();
    this.cache = cache;
  }

  clearL1(): void {
    this.l1.clear();
  }

  private remember(item: SharedMobilityDetailItem): void {
    this.l1.delete(item.id);
    this.l1.set(item.id, item);
    while (this.l1.size > this.maxL1Items) {
      const oldest = this.l1.keys().next().value;
      if (typeof oldest !== "string") break;
      this.l1.delete(oldest);
    }
  }

  private async mergeAndStore(key: string, incoming: SharedMobilityDetailItem[]): Promise<void> {
    if (!this.cache) return;
    try {
      const previous = await this.cache.get<DetailSnapshot>(key);
      const byId = new Map<string, SharedMobilityDetailItem>();
      for (const item of previous?.schemaVersion === 1 ? previous.items : []) {
        byId.set(item.id, item);
      }
      for (const item of incoming) byId.set(item.id, item);
      const items = [...byId.values()].slice(-this.maxSnapshotItems);
      await this.cache.set(
        key,
        { schemaVersion: 1, items } satisfies DetailSnapshot,
        this.ttlSeconds,
      );
    } catch {
      // Search/detail remain available through L1 when the shared cache is degraded.
    }
  }

  async store(items: SharedMobilityDetailItem[]): Promise<void> {
    const byScope = new Map<string, SharedMobilityDetailItem[]>();
    const legacyByOrigin = new Map<"motis-local" | "transitous", SharedMobilityDetailItem[]>();
    for (const item of items) {
      this.remember(item);
      const scope = sharedMobilityDetailScope(item.id);
      if (scope) {
        const scoped = byScope.get(scope) ?? [];
        scoped.push(item);
        byScope.set(scope, scoped);
      }
      if (item.servingOrigin) {
        const legacy = legacyByOrigin.get(item.servingOrigin) ?? [];
        legacy.push(item);
        legacyByOrigin.set(item.servingOrigin, legacy);
      }
    }
    await Promise.all([
      ...[...byScope].map(([scope, scoped]) => this.mergeAndStore(cacheKey(scope), scoped)),
      ...[...legacyByOrigin].map(([origin, scoped]) =>
        this.mergeAndStore(legacyCacheKey(origin), scoped),
      ),
    ]);
  }

  private async readSnapshot(key: string): Promise<SharedMobilityDetailItem[]> {
    try {
      const snapshot = await this.cache?.get<DetailSnapshot>(key);
      return snapshot?.schemaVersion === 1 ? snapshot.items : [];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<SharedMobilityDetailItem | null> {
    const l1 = this.l1.get(id);
    if (l1) return l1;

    const legacyNativeId = decodeLegacyId(id);
    if (legacyNativeId) {
      const snapshots = await Promise.all([
        this.readSnapshot(legacyCacheKey("motis-local")),
        this.readSnapshot(legacyCacheKey("transitous")),
      ]);
      const matches = snapshots
        .flat()
        .filter((item) => item.nativeId === legacyNativeId)
        .filter(
          (item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index,
        );
      if (matches.length !== 1) return null;
      const match = matches[0] ?? null;
      if (match) this.remember(match);
      return match;
    }

    const scope = sharedMobilityDetailScope(id);
    if (!scope) return null;
    const item = (await this.readSnapshot(cacheKey(scope))).find(
      (candidate) => candidate.id === id,
    );
    if (!item) return null;
    this.remember(item);
    return item;
  }
}
