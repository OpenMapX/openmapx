import { cacheNameFor, saveArea } from "./storage";
import {
  tileUrls as expandTileUrls,
  glyphUrls,
  resolveStyleAssets,
  spriteAssetUrls,
} from "./styleAssets";
import { tilesInBbox } from "./tiles";
import type { DownloadProgress, OfflineArea } from "./types";

const FETCH_CONCURRENCY = 6;

export interface OfflineStyleSource {
  /**
   * URL the app fetches for the style (cached as-is so MapLibre/loadOpenMapXStyle
   * still works offline). May contain placeholders that are resolved at runtime
   * by the app — those placeholders never produce a working tile/glyph URL on
   * their own, which is why the resolved JSON is passed in separately.
   */
  url: string;
  /**
   * Fully resolved style JSON used to discover tile/glyph/sprite URLs.
   * Callers MUST run any provider-specific resolution (e.g. loadOpenMapXStyle)
   * before passing this in — otherwise placeholder URLs leak through and the
   * download silently produces an unusable area.
   */
  json: Record<string, unknown>;
}

interface DownloadOptions {
  /**
   * Style sources to cache for this area. Pass multiple entries to support
   * runtime style switches (e.g. light + dark variants) — tile/glyph URLs
   * are deduped across all sources so there's no double-downloading.
   */
  styles: OfflineStyleSource[];
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /**
   * Pre-resolved URL list. When the Background Fetch path already built it (and
   * then fell back to the in-page downloader), pass it here so we don't re-fetch
   * every TileJSON and re-expand the whole tile list a second time.
   */
  prebuiltUrls?: AreaDownloadUrls;
}

/**
 * Downloads all assets for an offline area into a named cache.
 *
 * Steps:
 *  1. Fetch + cache the style JSON
 *  2. Resolve tile URL templates from the style (incl. TileJSON sub-fetches)
 *  3. Cache glyphs (Latin + common ranges) for each fontstack the style uses
 *  4. Cache sprite assets (json + png, @1x and @2x)
 *  5. Cache vector tiles for the bbox + zoom range
 *
 * Progress is reported per-asset; size is summed from response Content-Length
 * when available, otherwise from the response body byte length.
 */
export interface AreaDownloadUrls {
  /** Raw style JSON URLs — cached verbatim so the app's loader can refetch them. */
  styleUrls: string[];
  /** Tile / glyph / sprite / TileJSON asset URLs for the bbox + zoom range. */
  assetUrls: string[];
}

/**
 * Resolve every URL an offline area needs (style JSON + tiles + glyphs +
 * sprites + TileJSON) without fetching them. Shared by the in-page downloader
 * and the Background Fetch path so both cache exactly the same asset set.
 */
export async function buildAreaDownloadUrls(
  area: OfflineArea,
  styles: OfflineStyleSource[],
  signal?: AbortSignal,
): Promise<AreaDownloadUrls> {
  if (styles.length === 0) {
    throw new Error("buildAreaDownloadUrls: at least one style source is required");
  }
  const tileTemplateSet = new Set<string>();
  const tileJsonUrlSet = new Set<string>();
  const glyphUrlSet = new Set<string>();
  const spriteUrlSet = new Set<string>();

  for (const source of styles) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // Resolve from the pre-resolved JSON the caller provided — for placeholder
    // styles (e.g. openmapx-streets.json with __TILES_URL__) the raw bytes
    // would yield no discoverable tile/glyph/sprite URLs.
    const assets = await resolveStyleAssets(
      source.url,
      source.json as Parameters<typeof resolveStyleAssets>[1],
    );
    for (const t of assets.tileTemplates) tileTemplateSet.add(t);
    for (const t of assets.tileJsonUrls) tileJsonUrlSet.add(t);
    if (assets.glyphTemplate) {
      for (const u of glyphUrls(assets.glyphTemplate, assets.fontStacks)) glyphUrlSet.add(u);
    }
    for (const sprite of assets.spriteUrls) {
      for (const u of spriteAssetUrls(sprite)) spriteUrlSet.add(u);
    }
  }

  const tileCoords = tilesInBbox(area.bbox, area.minZoom, area.maxZoom);
  const tileFetchUrls = [...tileTemplateSet].flatMap((tpl) => expandTileUrls(tpl, tileCoords));
  // TileJSON URLs must be cached so MapLibre can re-resolve sources offline.
  const assetUrls = [...tileJsonUrlSet, ...spriteUrlSet, ...glyphUrlSet, ...tileFetchUrls];
  return { styleUrls: styles.map((s) => s.url), assetUrls };
}

export async function downloadArea(
  area: OfflineArea,
  options: DownloadOptions,
): Promise<OfflineArea> {
  const { styles, onProgress, signal } = options;
  if (styles.length === 0) {
    throw new Error("downloadArea: at least one style source is required");
  }
  const cache = await caches.open(cacheNameFor(area));

  const updateArea = (patch: Partial<OfflineArea>): OfflineArea => {
    const updated = { ...area, ...patch, updatedAt: Date.now() };
    Object.assign(area, updated);
    saveArea(area);
    return area;
  };

  let bytes = area.sizeBytes;
  let done = area.tilesDone;
  let total = 0;

  const report = (status: OfflineArea["status"], errorMessage?: string) => {
    onProgress?.({
      area,
      done,
      total,
      bytes,
      progress: total > 0 ? Math.min(1, done / total) : 0,
      status,
      errorMessage,
    });
  };

  updateArea({ status: "downloading" });
  report("downloading");

  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // Resolve the full asset URL list (shared with the Background Fetch path),
    // reusing a pre-built list when the caller already computed one.
    const { styleUrls, assetUrls } =
      options.prebuiltUrls ?? (await buildAreaDownloadUrls(area, styles, signal));

    // Cache the raw style JSON for each variant — the app's loader refetches
    // these and may post-process placeholders, so we cache the raw bytes
    // verbatim. Caching every variant the user might switch to (e.g. light +
    // dark) keeps the area usable across theme changes. Required: a failed
    // style fetch aborts the download.
    for (const url of styleUrls) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const styleResponse = await fetch(url, { signal });
      if (!styleResponse.ok) {
        throw new Error(`Failed to fetch style ${url}: ${styleResponse.status}`);
      }
      bytes += await responseSize(styleResponse.clone());
      await cache.put(url, styleResponse);
    }

    total = assetUrls.length;
    updateArea({ tileCount: total });
    report("downloading");

    // Fetch with concurrency cap
    let cursor = 0;
    let fatalError: Error | null = null;
    const next = (): string | null => {
      if (signal?.aborted) return null;
      if (fatalError) return null;
      if (cursor >= assetUrls.length) return null;
      const url = assetUrls[cursor];
      cursor += 1;
      return url;
    };

    const worker = async () => {
      while (true) {
        if (fatalError) return;
        const url = next();
        if (!url) return;
        try {
          const existing = await cache.match(url);
          if (existing) {
            done += 1;
            continue;
          }
          const response = await fetch(url, { signal });
          if (!response.ok) {
            // 4xx/5xx — typically a missing tile (e.g. ocean tiles past the
            // dataset's coverage). Treat as a benign skip so progress moves.
            done += 1;
            continue;
          }
          bytes += await responseSize(response.clone());
          await cache.put(url, response);
          done += 1;
        } catch (err) {
          const e = err as Error;
          if (e.name === "AbortError") throw e;
          // QuotaExceededError: storage is full — every subsequent cache.put
          // will fail too, so further work is pointless.
          // TypeError: thrown by fetch() on network failures (e.g. user went
          // offline mid-download). Continuing here would silently mark every
          // remaining tile as "done" and the area as ready. Surface it.
          if (
            e.name === "QuotaExceededError" ||
            e.name === "TypeError" ||
            /quota/i.test(e.message ?? "")
          ) {
            if (!fatalError) fatalError = e;
            return;
          }
          // Anything else — count as a benign skip.
          done += 1;
        }
        if (done % 25 === 0 || done === total) {
          updateArea({ tilesDone: done, sizeBytes: bytes });
          report("downloading");
        }
      }
    };

    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (fatalError) throw fatalError;

    updateArea({ status: "ready", tilesDone: done, sizeBytes: bytes });
    report("ready");
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    const message = aborted ? "Cancelled" : ((err as Error).message ?? String(err));
    updateArea({
      status: aborted ? "paused" : "error",
      tilesDone: done,
      sizeBytes: bytes,
      errorMessage: aborted ? undefined : message,
    });
    report(aborted ? "paused" : "error", aborted ? undefined : message);
    if (!aborted) throw err;
  }

  return area;
}

async function responseSize(response: Response): Promise<number> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const n = Number(lengthHeader);
    if (Number.isFinite(n) && n > 0) return n;
  }
  try {
    const buf = await response.arrayBuffer();
    return buf.byteLength;
  } catch {
    return 0;
  }
}
