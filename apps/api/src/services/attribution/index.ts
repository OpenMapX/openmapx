import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { TTL } from "@openmapx/mobility-core/policy";
import type Redis from "ioredis";
import { loadAttributionIndex } from "./index-loader.js";
import type { ManifestDataSource, MotisLicenseEntry, ResolvedAttribution } from "./types.js";

const REDIS_KEY_BY_SOURCE_ID = "attribution:bySourceId";
const REDIS_KEY_BY_MOTIS_FILENAME = "attribution:byMotisFilename";
const REDIS_TTL = TTL.STATIC_ARCHIVE;
const MTIME_POLL_INTERVAL_MS = 60_000;

export interface AttributionIndexInitOpts {
  redis?: Redis | null;
  log: Logger;
  motisLicenseFile?: string;
  integrationManifests?: ManifestDataSource[];
  /** When false, disables the 60s mtime poller (used by tests). */
  enableMtimePoller?: boolean;
}

/**
 * AttributionIndex — singleton runtime service that resolves Attribution rows
 * against MOTIS license.json and integration manifest dataSources. Loaded once
 * at startup, cached in memory + Redis, and refreshed when the MOTIS
 * license.json mtime changes (polled every 60s).
 */
export class AttributionIndex {
  private bySourceId: Map<string, ResolvedAttribution> = new Map();
  private byMotisFilename: Map<string, ResolvedAttribution> = new Map();
  private loadedAt = "";
  private motisLicenseMtime = 0;
  private mtimePollHandle: NodeJS.Timeout | null = null;

  private readonly redis: Redis | null;
  private readonly log: Logger;
  private readonly motisLicenseFile?: string;
  private integrationManifests: ManifestDataSource[];

  private constructor(opts: AttributionIndexInitOpts) {
    this.redis = opts.redis ?? null;
    this.log = opts.log;
    this.motisLicenseFile = opts.motisLicenseFile;
    this.integrationManifests = opts.integrationManifests ?? [];
  }

  static async init(opts: AttributionIndexInitOpts): Promise<AttributionIndex> {
    const idx = new AttributionIndex(opts);
    await idx.reload();
    if (opts.enableMtimePoller !== false) {
      idx.startMtimePoller();
    }
    return idx;
  }

  /** Replace the list of manifest dataSources (used on integration reloads). */
  setIntegrationManifests(manifests: ManifestDataSource[]): void {
    this.integrationManifests = manifests;
  }

  getById(sourceId: string): ResolvedAttribution | undefined {
    return this.bySourceId.get(sourceId);
  }

  getForMotisFile(filename: string): ResolvedAttribution | undefined {
    return this.byMotisFilename.get(filename);
  }

  /** Get every loaded ResolvedAttribution, ordered as the maps are. */
  list(): ResolvedAttribution[] {
    return Array.from(this.bySourceId.values());
  }

  /**
   * Enumerate every loaded MOTIS feed tag (the `de_DELFI` part of
   * `de_DELFI.gtfs.zip`). Used by MOTIS-derived providers to extract the
   * matching feed tag from a `ms:<feed>_<stop>` style id by longest-prefix
   * match — the same trick `transit-motis/local.ts` used to do with its
   * internal index.
   */
  listMotisFeedTags(): string[] {
    const tags: string[] = [];
    for (const v of this.bySourceId.values()) {
      if (v.source === "motis-license") tags.push(v.sourceId);
    }
    return tags;
  }

  /**
   * Given a set of partial Attribution objects (typically from a MobilityResult),
   * resolve each sourceId against the index and return a deduplicated, ordered
   * list:
   *
   *   1. Integration-manifest entries (most curated) first.
   *   2. Then motis-license entries.
   *   3. Within each group, sort alphabetically by sourceId for stability.
   *
   * Unknown sourceIds pass through as their input shape (no extra metadata)
   * and are grouped after the motis-license entries, also sorted by sourceId.
   */
  dedupAndOrder(attrs: Attribution[]): ResolvedAttribution[] {
    const seen = new Set<string>();
    const manifestGroup: ResolvedAttribution[] = [];
    const motisGroup: ResolvedAttribution[] = [];
    const unknownGroup: ResolvedAttribution[] = [];

    for (const attr of attrs) {
      if (!attr?.sourceId) continue;
      if (seen.has(attr.sourceId)) continue;
      seen.add(attr.sourceId);

      const resolved = this.bySourceId.get(attr.sourceId);
      if (resolved) {
        if (resolved.source === "integration-manifest") {
          manifestGroup.push(resolved);
        } else {
          motisGroup.push(resolved);
        }
      } else {
        // Pass-through shape — preserve caller's fields but tag the origin as
        // integration-manifest because that is the most common reason a caller
        // supplied an Attribution we don't have an indexed row for (a
        // hand-rolled integration row predating the manifest).
        unknownGroup.push({
          ...attr,
          source: "integration-manifest",
        });
      }
    }

    const byId = (a: ResolvedAttribution, b: ResolvedAttribution): number =>
      a.sourceId.localeCompare(b.sourceId);
    manifestGroup.sort(byId);
    motisGroup.sort(byId);
    unknownGroup.sort(byId);

    const out = [...manifestGroup, ...motisGroup, ...unknownGroup];
    void this.cacheToRedis(out).catch(() => {
      // best-effort cache write
    });
    return out;
  }

  /** Reload license.json + manifests, repopulating in-memory state and Redis. */
  async reload(): Promise<void> {
    const result = await loadAttributionIndex({
      motisLicenseFile: this.motisLicenseFile,
      integrationManifests: this.integrationManifests,
      log: this.log,
    });
    this.bySourceId = result.bySourceId;
    this.byMotisFilename = result.byMotisFilename;
    this.loadedAt = result.loadedAt;
    this.motisLicenseMtime = result.motisLicenseMtime ?? 0;

    await this.invalidateRedis();
    await this.warmRedis();
  }

  /** Stop the mtime poller — call this on shutdown. */
  close(): void {
    if (this.mtimePollHandle) {
      clearInterval(this.mtimePollHandle);
      this.mtimePollHandle = null;
    }
  }

  /** Counts + last load time, for the /attribution/health endpoint. */
  health(): {
    sources: number;
    motisFeeds: number;
    manifestSources: number;
    loadedAt: string;
  } {
    let motis = 0;
    let manifest = 0;
    for (const v of this.bySourceId.values()) {
      if (v.source === "motis-license") motis += 1;
      else manifest += 1;
    }
    return {
      sources: this.bySourceId.size,
      motisFeeds: motis,
      manifestSources: manifest,
      loadedAt: this.loadedAt,
    };
  }

  private startMtimePoller(): void {
    this.mtimePollHandle = setInterval(() => {
      if (!this.motisLicenseFile) return;
      try {
        if (!existsSync(this.motisLicenseFile)) return;
        const mtime = statSync(this.motisLicenseFile).mtimeMs;
        if (mtime === this.motisLicenseMtime) return;
        this.log.info(
          `[attribution-index] license.json mtime changed (${this.motisLicenseMtime} -> ${mtime}); reloading`,
        );
        void this.reload().catch((err) => {
          this.log.warn(
            `[attribution-index] reload failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      } catch {
        // ignore transient stat failures
      }
    }, MTIME_POLL_INTERVAL_MS);
    this.mtimePollHandle.unref();
  }

  private async invalidateRedis(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.scanAndDelete(`${REDIS_KEY_BY_SOURCE_ID}:*`);
      await this.scanAndDelete(`${REDIS_KEY_BY_MOTIS_FILENAME}:*`);
    } catch (err) {
      this.log.warn(
        `[attribution-index] Redis invalidate failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async scanAndDelete(pattern: string): Promise<void> {
    if (!this.redis) return;
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  private async warmRedis(): Promise<void> {
    if (!this.redis) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const [sid, attr] of this.bySourceId) {
        pipeline.setex(`${REDIS_KEY_BY_SOURCE_ID}:${sid}`, REDIS_TTL, JSON.stringify(attr));
      }
      for (const [filename, attr] of this.byMotisFilename) {
        pipeline.setex(
          `${REDIS_KEY_BY_MOTIS_FILENAME}:${filename}`,
          REDIS_TTL,
          JSON.stringify(attr),
        );
      }
      await pipeline.exec();
    } catch (err) {
      this.log.warn(
        `[attribution-index] Redis warm failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async cacheToRedis(attrs: ResolvedAttribution[]): Promise<void> {
    if (!this.redis) return;
    const pipeline = this.redis.pipeline();
    for (const attr of attrs) {
      pipeline.setex(`${REDIS_KEY_BY_SOURCE_ID}:${attr.sourceId}`, REDIS_TTL, JSON.stringify(attr));
    }
    await pipeline.exec();
  }
}

/**
 * Default MOTIS license.json path. Honours `MOTIS_LICENSE_FILE`, otherwise
 * falls back to `<OPENMAPX_ROOT_DIR | cwd>/infra/docker/data/motis-data/license.json`.
 */
export function defaultMotisLicenseFile(): string {
  const fromEnv = process.env.MOTIS_LICENSE_FILE;
  if (fromEnv) return fromEnv;
  const rootDir = process.env.OPENMAPX_ROOT_DIR ?? process.cwd();
  return join(rootDir, "infra", "docker", "data", "motis", "live", "license.json");
}

let singleton: AttributionIndex | null = null;

/**
 * Get the lazily-initialised global AttributionIndex instance, or null when
 * not yet initialised. The integration host hands this to IntegrationContext
 * so providers can resolve attribution lazily without circular imports.
 */
export function getAttributionIndex(): AttributionIndex | null {
  return singleton;
}

/** Set (or clear) the global AttributionIndex instance. */
export function setAttributionIndex(idx: AttributionIndex | null): void {
  singleton = idx;
}

export type { ManifestDataSource, MotisLicenseEntry, ResolvedAttribution };
