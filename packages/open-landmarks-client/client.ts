import { createHash } from "node:crypto";
import type {
  HttpClient,
  LandmarkAsset,
  LandmarkCatalogueSnapshot,
  LandmarkModelFetchResult,
  Logger,
} from "@openmapx/integration-framework";
import { resolveUpstreamUrl } from "./normalize";
import {
  assetRecordSchema,
  assetsDocumentSchema,
  catalogueSchema,
  type OpenLandmarksAssetRecord,
  pointerSchema,
} from "./schema";

export interface OpenLandmarksClientOptions {
  baseUrl: string;
  channel: "latest" | "preview";
  /** Whether the upstream keeps old release files reachable after a new release. */
  retainsReleases: boolean;
  http: Pick<HttpClient, "getText" | "getBytes">;
  log: Logger;
  normalize: (record: OpenLandmarksAssetRecord) => LandmarkAsset | null;
  now?: () => number;
  refreshIntervalMs?: number;
}

export interface OpenLandmarksClient {
  /** First load in the background, then periodic refreshes. Never throws. */
  start(): void;
  stop(): void;
  snapshot(): LandmarkCatalogueSnapshot | null;
  refresh(): Promise<void>;
  fetchModelGzip(sha256: string, signal: AbortSignal): Promise<LandmarkModelFetchResult>;
  status(): { release: string | null; fetchedAt: string | null; lastError: string | null };
}

interface ModelEntry {
  gzipUrl: string;
  gzipSha256: string;
}

const MIB = 1024 * 1024;
const POINTER_MAX_BYTES = 1 * MIB;
const ASSETS_MAX_BYTES = 32 * MIB;
const ASSETS_TIMEOUT_MS = 60_000;
const MODEL_MAX_BYTES = 4 * MIB;
const MINUTE = 60_000;
const DEFAULT_REFRESH_MS = 6 * 60 * MINUTE;
const FIRST_BACKOFF_MS = MINUTE;
const MAX_BACKOFF_MS = 30 * MINUTE;
const EARLY_REFRESH_INTERVAL_MS = 10 * MINUTE;
const JSON_TYPES = ["application/json"] as const;
const GZIP_TYPES = ["application/gzip", "application/x-gzip", "application/octet-stream"] as const;

class NotFoundError extends Error {}

export function createOpenLandmarksClient(
  options: OpenLandmarksClientOptions,
): OpenLandmarksClient {
  const { baseUrl, http, log } = options;
  const now = options.now ?? Date.now;
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  const host = new URL(baseUrl).host;
  const pointerUrl = resolveUpstreamUrl(baseUrl, `/api/v1/${options.channel}.json`);

  let current: LandmarkCatalogueSnapshot | null = null;
  let models = new Map<string, ModelEntry>();
  let previousModels = new Map<string, ModelEntry>();
  let lastError: string | null = null;
  let loggedInvalidRelease: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let failures = 0;
  let lastEarlyRefresh = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  async function getJson(url: string, large: boolean): Promise<unknown> {
    const response = await http.getText(url, {
      maxBytes: large ? ASSETS_MAX_BYTES : POINTER_MAX_BYTES,
      contentTypes: JSON_TYPES,
      redirect: "error",
      ...(large ? { timeoutMs: ASSETS_TIMEOUT_MS } : {}),
    });
    if (response.status === 404) throw new NotFoundError(`${host} answered 404`);
    if (response.status !== 200) throw new Error(`${host} answered status ${response.status}`);
    return JSON.parse(response.body) as unknown;
  }

  async function readPointer() {
    const parsed = pointerSchema.safeParse(await getJson(pointerUrl, false));
    if (!parsed.success) throw new Error(`${host} release pointer is invalid`);
    return parsed.data;
  }

  function load(release: string, records: readonly unknown[]): void {
    const assets: LandmarkAsset[] = [];
    const nextModels = new Map<string, ModelEntry>();
    let invalid = 0;
    for (const raw of records) {
      const parsed = assetRecordSchema.safeParse(raw);
      if (!parsed.success) {
        invalid += 1;
        continue;
      }
      const asset = options.normalize(parsed.data);
      if (!asset) continue;
      assets.push(asset);
      const { low, detail } = parsed.data.lods;
      for (const lod of asset.lods.detail && detail ? [low, detail] : [low]) {
        if (nextModels.has(lod.sha256)) continue;
        nextModels.set(lod.sha256, {
          gzipUrl: resolveUpstreamUrl(baseUrl, lod.gzip.url),
          gzipSha256: lod.gzip.sha256,
        });
      }
    }
    if (invalid > 0 && loggedInvalidRelease !== release) {
      loggedInvalidRelease = release;
      log.warn(`Landmark catalogue from ${host} dropped invalid records`, { release, invalid });
    }
    previousModels = options.retainsReleases ? models : new Map();
    models = nextModels;
    current = { release, fetchedAt: new Date(now()).toISOString(), assets };
  }

  async function refreshOnce(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const pointer = await readPointer();
      if (pointer.release === null || pointer.catalogue === null) {
        previousModels = new Map();
        models = new Map();
        current = { release: "none", fetchedAt: new Date(now()).toISOString(), assets: [] };
        return;
      }
      if (current && current.release === pointer.release) {
        current = { ...current, fetchedAt: new Date(now()).toISOString() };
        return;
      }
      try {
        const catalogue = catalogueSchema.safeParse(
          await getJson(resolveUpstreamUrl(baseUrl, pointer.catalogue), false),
        );
        if (!catalogue.success) throw new Error(`${host} catalogue is invalid`);
        const document = assetsDocumentSchema.safeParse(
          await getJson(resolveUpstreamUrl(baseUrl, catalogue.data.assets), true),
        );
        if (!document.success) throw new Error(`${host} assets document is invalid`);
        load(pointer.release, document.data.assets);
        return;
      } catch (error) {
        // A deploy can replace the release between the pointer and its files.
        if (error instanceof NotFoundError && attempt === 0) continue;
        throw error;
      }
    }
  }

  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = refreshOnce()
      .then(
        () => {
          lastError = null;
        },
        (error: unknown) => {
          lastError = error instanceof Error ? error.message : String(error);
          throw error;
        },
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    (timer as { unref?: () => void }).unref?.();
  }

  function run(): void {
    refresh().then(
      () => {
        failures = 0;
        schedule(refreshIntervalMs);
      },
      () => {
        const delay = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** failures);
        failures += 1;
        log.warn(`Landmark catalogue from ${host} could not be loaded`, { lastError });
        schedule(delay);
      },
    );
  }

  function refreshEarly(): void {
    if (now() - lastEarlyRefresh < EARLY_REFRESH_INTERVAL_MS) return;
    lastEarlyRefresh = now();
    refresh().catch(() => undefined);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      run();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    snapshot: () => current,
    refresh,
    status: () => ({
      release: current?.release ?? null,
      fetchedAt: current?.fetchedAt ?? null,
      lastError,
    }),
    async fetchModelGzip(sha256, signal) {
      const entry = models.get(sha256) ?? previousModels.get(sha256);
      if (!entry) return { status: "unlisted" };
      const response = await http.getBytes(entry.gzipUrl, {
        maxBytes: MODEL_MAX_BYTES,
        contentTypes: GZIP_TYPES,
        redirect: "error",
        signal,
      });
      if (response.status === 404) {
        refreshEarly();
        return { status: "gone" };
      }
      if (response.status !== 200)
        throw new Error(`landmark model upstream status ${response.status}`);
      const actual = createHash("sha256").update(response.bytes).digest("hex");
      if (actual !== entry.gzipSha256) {
        log.warn("Landmark model failed verification", { provider: host, sha256 });
        throw new Error("landmark model hash mismatch");
      }
      return { status: "ok", gzip: response.bytes };
    },
  };
}
