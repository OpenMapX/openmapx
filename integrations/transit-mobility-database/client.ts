import type { CacheClient } from "@openmapx/integration-framework";
import type { MdbFeed, MdbTokenResponse } from "./types.js";

const DEFAULT_BASE_URL = "https://api.mobilitydatabase.org";
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_FEEDS = 10_000;
const FEED_LIST_TTL = 48 * 60 * 60; // 48 h, matches the dynamic-registry cadence

const ACCESS_TOKEN_SAFETY_SECONDS = 60;

type FeedKind = "gtfs" | "gtfs_rt" | "gbfs";

interface FetchPageResult {
  feeds: MdbFeed[];
  /** True when MDB returned fewer than the requested page size (end of list). */
  done: boolean;
}

export interface MdbClientConfig {
  refreshToken: string;
  baseUrl?: string;
  cache?: CacheClient;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Override `Date.now` for tests. */
  now?: () => number;
}

/**
 * Client for api.mobilitydatabase.org with refresh-token → access-token
 * exchange, transparent retry on 401, and Redis-backed feed-list caching.
 *
 * The client is intentionally narrow: it only fetches feed metadata. We
 * never proxy feed bytes (GTFS zips or GTFS-RT protobufs) — the existing
 * GTFS importer downloads zips directly from agency URLs.
 */
export class MdbClient {
  private readonly refreshToken: string;
  private readonly baseUrl: string;
  private readonly cache?: CacheClient;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(config: MdbClientConfig) {
    this.refreshToken = config.refreshToken;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.cache = config.cache;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  /** Fetch all GTFS schedule feeds, with Redis cache (TTL 48h). */
  async listGtfsFeeds(): Promise<MdbFeed[]> {
    return this.listCachedFeeds("gtfs");
  }

  /** Fetch all GTFS-Realtime feeds. URLs only — bytes are never proxied. */
  async listGtfsRtFeeds(): Promise<MdbFeed[]> {
    return this.listCachedFeeds("gtfs_rt");
  }

  /** Fetch all GBFS systems. */
  async listGbfsFeeds(): Promise<MdbFeed[]> {
    return this.listCachedFeeds("gbfs");
  }

  /**
   * Read-through cache around the paginated feed-list endpoints. The cache
   * key carries the feed kind; each kind gets its own 48h-TTL entry.
   */
  private async listCachedFeeds(kind: FeedKind): Promise<MdbFeed[]> {
    const cacheKey = `feeds:${kind}:v1`;
    if (this.cache) {
      const cached = await this.cache.get<MdbFeed[]>(cacheKey).catch(() => null);
      if (cached && Array.isArray(cached)) return cached;
    }

    const feeds = await this.fetchAllPages(kind);

    if (this.cache && feeds.length > 0) {
      await this.cache.set(cacheKey, feeds, FEED_LIST_TTL).catch(() => {});
    }
    return feeds;
  }

  private endpointFor(kind: FeedKind): string {
    if (kind === "gtfs") return "/v1/gtfs_feeds";
    if (kind === "gtfs_rt") return "/v1/gtfs_rt_feeds";
    return "/v1/gbfs_feeds";
  }

  private async fetchAllPages(kind: FeedKind): Promise<MdbFeed[]> {
    const all: MdbFeed[] = [];
    let offset = 0;
    const endpoint = this.endpointFor(kind);

    while (all.length < MAX_FEEDS) {
      const { feeds, done } = await this.fetchPage(endpoint, offset);
      all.push(...feeds);
      if (done || feeds.length === 0) break;
      offset += feeds.length;
    }
    return all;
  }

  private async fetchPage(endpoint: string, offset: number): Promise<FetchPageResult> {
    const url = `${this.baseUrl}${endpoint}?limit=${PAGE_SIZE}&offset=${offset}`;
    const data = await this.authedJsonGet<MdbFeed[] | { results: MdbFeed[] }>(url);

    // MDB has shipped both shapes across versions: bare array, or `{ results }`.
    const feeds = Array.isArray(data) ? data : (data?.results ?? []);
    return { feeds, done: feeds.length < PAGE_SIZE };
  }

  /**
   * GET with `Authorization: Bearer <access_token>`. On 401, refresh the
   * access token once and retry. Anything else throws — the caller wraps
   * with cache fallback.
   */
  private async authedJsonGet<T>(url: string): Promise<T> {
    let token = await this.getAccessToken();
    let response = await this.timedFetch(url, token);
    if (response.status === 401) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      token = await this.getAccessToken();
      response = await this.timedFetch(url, token);
    }
    if (!response.ok) {
      throw new Error(`MDB ${response.status} ${response.statusText} for ${url}`);
    }
    return (await response.json()) as T;
  }

  private async timedFetch(url: string, accessToken: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const url = `${this.baseUrl}/v1/tokens`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh_token: this.refreshToken }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`MDB token exchange ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as MdbTokenResponse;
    const expiresInSec = body.expires_in ?? body.expiration ?? 3600;
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = this.now() + (expiresInSec - ACCESS_TOKEN_SAFETY_SECONDS) * 1000;
    return this.accessToken;
  }
}
