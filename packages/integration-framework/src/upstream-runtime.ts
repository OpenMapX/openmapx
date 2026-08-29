export interface UpstreamCacheTtl {
  softMs: number;
  hardMs: number;
  /** Maximum total age at which a failed refresh may still use the record. */
  staleIfErrorMs: number;
}

export type UpstreamCacheRead<T> =
  | { state: "miss"; diagnostic?: "store_unavailable" | "invalid_record" }
  | {
      state: "fresh" | "stale" | "stale-if-error";
      value: T;
      storedAt: number;
      softExpiresAt: number;
      hardExpiresAt: number;
      staleIfErrorUntil: number;
    };

export interface QuotaWindow {
  id: string;
  limit: number;
  durationMs: number;
}

export interface QuotaDecision {
  allowed: boolean;
  remaining: Readonly<Record<string, number>>;
  retryAt: number | null;
  diagnostic?: "store_unavailable";
}

export interface UpstreamRuntime {
  read<T>(key: string, now?: number): Promise<UpstreamCacheRead<T>>;
  write<T>(key: string, value: T, ttl: UpstreamCacheTtl): Promise<void>;
  acquireLease(key: string, ttlMs: number): Promise<{ token: string } | null>;
  releaseLease(key: string, token: string): Promise<void>;
  consumeQuota(input: {
    bucket: string;
    cost: number;
    windows: readonly QuotaWindow[];
  }): Promise<QuotaDecision>;
}
