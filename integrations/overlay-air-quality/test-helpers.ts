import type {
  QuotaDecision,
  QuotaWindow,
  UpstreamCacheRead,
  UpstreamCacheTtl,
  UpstreamRuntime,
} from "@openmapx/integration-framework";

interface StoredValue {
  value: unknown;
  storedAt: number;
  softExpiresAt: number;
  hardExpiresAt: number;
  staleIfErrorUntil: number;
}

export class MemoryUpstreamRuntime implements UpstreamRuntime {
  readonly values = new Map<string, StoredValue>();
  readonly quotaCalls: Array<{ bucket: string; cost: number; windows: readonly QuotaWindow[] }> =
    [];
  readonly leases = new Map<string, string>();
  quotaDecision: QuotaDecision = { allowed: true, remaining: {}, retryAt: null };

  constructor(readonly now: () => number = Date.now) {}

  async read<T>(key: string, at = this.now()): Promise<UpstreamCacheRead<T>> {
    const record = this.values.get(key);
    if (!record || at >= record.staleIfErrorUntil) return { state: "miss" };
    return {
      state:
        at < record.softExpiresAt
          ? "fresh"
          : at < record.hardExpiresAt
            ? "stale"
            : "stale-if-error",
      value: record.value as T,
      storedAt: record.storedAt,
      softExpiresAt: record.softExpiresAt,
      hardExpiresAt: record.hardExpiresAt,
      staleIfErrorUntil: record.staleIfErrorUntil,
    };
  }

  async write<T>(key: string, value: T, ttl: UpstreamCacheTtl): Promise<void> {
    const at = this.now();
    this.values.set(key, {
      value,
      storedAt: at,
      softExpiresAt: at + ttl.softMs,
      hardExpiresAt: at + ttl.hardMs,
      staleIfErrorUntil: at + ttl.staleIfErrorMs,
    });
  }

  async acquireLease(key: string): Promise<{ token: string } | null> {
    if (this.leases.has(key)) return null;
    const token = `lease-${this.leases.size + 1}`;
    this.leases.set(key, token);
    return { token };
  }

  async releaseLease(key: string, token: string): Promise<void> {
    if (this.leases.get(key) === token) this.leases.delete(key);
  }

  async consumeQuota(input: {
    bucket: string;
    cost: number;
    windows: readonly QuotaWindow[];
  }): Promise<QuotaDecision> {
    this.quotaCalls.push(input);
    return this.quotaDecision;
  }
}
