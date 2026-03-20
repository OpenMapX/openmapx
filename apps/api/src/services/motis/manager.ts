import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { cacheGet, cacheSet } from "../../utils/cache.js";
import { validatePublicUrl } from "../../utils/validate-url";
import type { BBox } from "../transit/types";
import type { MotisFeed, MotisStatus } from "./types";

const execFileAsync = promisify(execFile);

const MOTIS_URL = process.env.MOTIS_URL ?? "http://localhost:8081";
const MOTIS_DATA_DIR =
  process.env.MOTIS_DATA_DIR ?? join(process.cwd(), "../../infra/docker/data/motis");
const STATE_FILE = "openmapx-feeds.json";
const TIMEOUT_MS = 8_000;

interface FeedState {
  feeds: MotisFeed[];
  /** Incremented every time feeds change — compared against last restart value. */
  version: number;
  lastRestartVersion: number;
}

class MotisManager {
  private state: FeedState = { feeds: [], version: 0, lastRestartVersion: 0 };
  private initialized = false;

  get dataDir(): string {
    return MOTIS_DATA_DIR;
  }

  get url(): string {
    return MOTIS_URL;
  }

  /** Load persisted feed state from the data directory. */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (!existsSync(MOTIS_DATA_DIR)) {
      try {
        mkdirSync(MOTIS_DATA_DIR, { recursive: true });
      } catch {
        console.warn("[motis] Could not create data directory:", MOTIS_DATA_DIR);
        return;
      }
    }

    const stateFile = join(MOTIS_DATA_DIR, STATE_FILE);
    if (existsSync(stateFile)) {
      try {
        const raw = readFileSync(stateFile, "utf-8");
        const parsed = JSON.parse(raw) as FeedState;
        this.state = {
          feeds: parsed.feeds ?? [],
          version: parsed.version ?? 0,
          lastRestartVersion: parsed.lastRestartVersion ?? 0,
        };
        // Mark any interrupted downloads as failed
        for (const feed of this.state.feeds) {
          if (feed.status === "pending" || feed.status === "downloading") {
            const feedPath = join(MOTIS_DATA_DIR, feed.filename);
            if (!existsSync(feedPath)) {
              feed.status = "failed";
              feed.errorMessage = "Download interrupted";
            } else {
              feed.status = "ready";
            }
          }
        }
      } catch {
        console.warn("[motis] Could not parse state file, starting fresh");
      }
    }

    // Reconcile: check that files listed in state actually exist
    for (const feed of this.state.feeds) {
      if (feed.status === "ready") {
        const feedPath = join(MOTIS_DATA_DIR, feed.filename);
        if (!existsSync(feedPath)) {
          feed.status = "failed";
          feed.errorMessage = "File missing from data directory";
        }
      }
    }

    this.persist();
    console.log(
      `[motis] Initialized with ${this.state.feeds.length} feeds (data: ${MOTIS_DATA_DIR})`,
    );
  }

  private persist(): void {
    try {
      const stateFile = join(MOTIS_DATA_DIR, STATE_FILE);
      writeFileSync(stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn("[motis] Could not persist state:", err);
    }
  }

  /** Check if the MOTIS instance is reachable. */
  async isReachable(): Promise<boolean> {
    const cacheKey = "motis:reachable";
    const cached = await cacheGet<boolean>(cacheKey);
    if (cached !== null) return cached;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(`${MOTIS_URL}/api/v1/map/stops?min=0,0&max=0.01,0.01`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      const reachable = res.ok || res.status === 400;
      await cacheSet(cacheKey, reachable, 30);
      return reachable;
    } catch {
      await cacheSet(cacheKey, false, 30);
      return false;
    }
  }

  /** Get full MOTIS status including feed list and connectivity. */
  async getStatus(): Promise<MotisStatus> {
    const reachable = await this.isReachable();
    return {
      configured: !!process.env.MOTIS_URL || existsSync(MOTIS_DATA_DIR),
      url: MOTIS_URL,
      reachable,
      feeds: this.state.feeds,
      needsRestart: this.state.version !== this.state.lastRestartVersion,
    };
  }

  getFeeds(): MotisFeed[] {
    return this.state.feeds;
  }

  getFeed(slug: string): MotisFeed | undefined {
    return this.state.feeds.find((f) => f.slug === slug);
  }

  /** Download a GTFS feed and place it in the MOTIS data directory. */
  async addFeed(opts: {
    slug: string;
    name: string;
    url: string;
    countryCode: string;
    bbox?: BBox | null;
  }): Promise<MotisFeed> {
    // Check for duplicates
    const existing = this.state.feeds.find((f) => f.slug === opts.slug);
    if (existing && existing.status === "ready") {
      throw new Error(`Feed "${opts.slug}" already exists`);
    }

    // Remove failed entry with same slug if exists
    this.state.feeds = this.state.feeds.filter((f) => f.slug !== opts.slug);

    const filename = `${opts.slug}.gtfs.zip`;
    const feed: MotisFeed = {
      slug: opts.slug,
      name: opts.name,
      url: opts.url,
      countryCode: opts.countryCode,
      status: "pending",
      filename,
      addedAt: new Date().toISOString(),
      errorMessage: null,
      bbox: opts.bbox ?? null,
    };

    this.state.feeds.push(feed);
    this.persist();

    // Download in background
    this.downloadFeed(feed).catch((err) => {
      console.error(`[motis] Feed download failed for ${opts.slug}:`, err);
    });

    return feed;
  }

  private async downloadFeed(feed: MotisFeed): Promise<void> {
    validatePublicUrl(feed.url);
    const destPath = join(MOTIS_DATA_DIR, feed.filename);
    feed.status = "downloading";
    this.persist();

    try {
      await execFileAsync(
        "curl",
        ["-fsSL", "--proto", "=https,http", "--max-time", "300", "-o", destPath, feed.url],
        {
          timeout: 310_000,
        },
      );

      if (!existsSync(destPath)) {
        throw new Error("Download produced no output file");
      }

      feed.status = "ready";
      feed.errorMessage = null;
      this.state.version++;
      console.log(`[motis] Feed "${feed.slug}" downloaded to ${destPath}`);
    } catch (err) {
      feed.status = "failed";
      feed.errorMessage = err instanceof Error ? err.message : "Download failed";
      // Clean up partial download
      if (existsSync(destPath)) {
        try {
          rmSync(destPath);
        } catch {
          // ignore
        }
      }
    }

    this.persist();
  }

  /** Remove a feed from the MOTIS data directory. */
  removeFeed(slug: string): boolean {
    const idx = this.state.feeds.findIndex((f) => f.slug === slug);
    if (idx === -1) return false;

    const feed = this.state.feeds[idx];
    const feedPath = join(MOTIS_DATA_DIR, feed.filename);

    // Remove the file
    if (existsSync(feedPath)) {
      try {
        rmSync(feedPath);
      } catch (err) {
        console.warn(`[motis] Could not remove feed file ${feedPath}:`, err);
      }
    }

    this.state.feeds.splice(idx, 1);
    this.state.version++;
    this.persist();

    console.log(`[motis] Removed feed "${slug}"`);
    return true;
  }

  /** Mark that the MOTIS container has been restarted with current feeds. */
  markRestarted(): void {
    this.state.lastRestartVersion = this.state.version;
    this.persist();
  }

  /** List .zip files in the data directory that aren't tracked by the manager. */
  getUntrackedFiles(): string[] {
    if (!existsSync(MOTIS_DATA_DIR)) return [];
    const files = readdirSync(MOTIS_DATA_DIR).filter(
      (f) => f.endsWith(".zip") || f.endsWith(".pbf"),
    );
    const tracked = new Set(this.state.feeds.map((f) => f.filename));
    return files.filter((f) => !tracked.has(f));
  }
}

export const motisManager = new MotisManager();
