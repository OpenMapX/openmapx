"use client";

import { saveArea } from "./storage";
import type { OfflineArea } from "./types";

// Minimal typings for the Background Fetch API (not in lib.dom). Only the bits
// we use are declared.
interface BackgroundFetchRegistrationLike extends EventTarget {
  readonly id: string;
  readonly downloaded: number;
  readonly downloadTotal: number;
}

interface BackgroundFetchManagerLike {
  fetch(
    id: string,
    requests: string[],
    options?: {
      title?: string;
      icons?: Array<{ src: string; sizes?: string; type?: string }>;
      downloadTotal?: number;
    },
  ): Promise<BackgroundFetchRegistrationLike>;
  get(id: string): Promise<BackgroundFetchRegistrationLike | undefined>;
}

type RegistrationWithBgFetch = ServiceWorkerRegistration & {
  backgroundFetch: BackgroundFetchManagerLike;
};

/** Cache (page + SW share it) where the SW writes a per-area completion marker. */
const RESULTS_CACHE = "omx-offline-results";

interface AreaResult {
  ok: boolean;
  downloaded?: number;
  count?: number;
  reason?: string;
}

function resultKey(id: string): string {
  return `/__offline-area-result/${encodeURIComponent(id)}`;
}

/** Whether Background Fetch is available (Chromium-only at time of writing). */
export function supportsBackgroundFetch(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof ServiceWorkerRegistration !== "undefined" &&
    "backgroundFetch" in ServiceWorkerRegistration.prototype
  );
}

/**
 * Kick off an offline-area download via Background Fetch. The OS shows progress
 * and the download survives navigation / the page being closed; the SW stores
 * the results into the `offline-area-<id>` cache. Returns the registration (so
 * the caller can watch `progress` while the page stays open) or null when
 * unsupported or the call failed — callers fall back to the in-page downloader.
 */
export async function startBackgroundAreaDownload(
  area: OfflineArea,
  urls: string[],
  options: { title: string },
): Promise<BackgroundFetchRegistrationLike | null> {
  if (!supportsBackgroundFetch()) return null;
  try {
    const reg = (await navigator.serviceWorker.ready) as RegistrationWithBgFetch;
    // Intentionally NO downloadTotal: per the Background Fetch spec the browser
    // ABORTS the whole download once actual bytes exceed downloadTotal, and tile
    // sizes are unpredictable, so any estimate risks killing a good download.
    // We show estimated progress in-app instead (the OS notification falls back
    // to a byte count without a percentage).
    return await reg.backgroundFetch.fetch(area.id, urls, {
      title: options.title,
      icons: [{ src: "/icons/app/icon-192.png", sizes: "192x192", type: "image/png" }],
    });
  } catch {
    return null;
  }
}

/**
 * Watch an in-flight background download's byte progress while the page is open.
 * Returns a detach function. No-op (returns a noop) when unsupported or the
 * registration is gone (already finished).
 */
export async function watchBackgroundAreaProgress(
  id: string,
  onProgress: (downloaded: number) => void,
): Promise<(() => void) | null> {
  if (!supportsBackgroundFetch()) return null;
  try {
    const reg = (await navigator.serviceWorker.ready) as RegistrationWithBgFetch;
    const bgFetch = await reg.backgroundFetch.get(id);
    // null (not a noop) signals "no live registration" so callers can tell a
    // genuinely in-flight download from a lost one.
    if (!bgFetch) return null;
    const listener = () => onProgress(bgFetch.downloaded);
    bgFetch.addEventListener("progress", listener);
    listener();
    return () => bgFetch.removeEventListener("progress", listener);
  } catch {
    return null;
  }
}

async function readAreaResult(id: string): Promise<AreaResult | null> {
  if (typeof caches === "undefined") return null;
  try {
    if (!(await caches.has(RESULTS_CACHE))) return null;
    const cache = await caches.open(RESULTS_CACHE);
    const res = await cache.match(resultKey(id));
    return res ? ((await res.json()) as AreaResult) : null;
  } catch {
    return null;
  }
}

/** Remove a consumed completion marker. */
export async function clearAreaResult(id: string): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(RESULTS_CACHE);
    await cache.delete(resultKey(id));
  } catch {
    // best-effort
  }
}

/**
 * If a background download for this area has finished, fold its result into the
 * stored record (status ready/error + final byte/tile counts) and clear the
 * marker. Returns the updated area, or null when there's nothing to reconcile.
 */
export async function reconcileAreaFromResult(area: OfflineArea): Promise<OfflineArea | null> {
  const result = await readAreaResult(area.id);
  if (!result) return null;
  // A "successful" fetch that cached nothing (even the style/glyphs failed) is
  // really a failure — don't present it as a ready download with no usable data.
  const ok = result.ok && (result.count ?? 0) > 0;
  const updated: OfflineArea = {
    ...area,
    status: ok ? "ready" : "error",
    // On success the area is complete: show full progress. Some requested tiles
    // are legitimately 4xx (ocean / out-of-coverage) and were skipped, so
    // result.count < tileCount; the in-page downloader counts those as done too,
    // so mirror that here rather than showing a complete area as partial.
    tilesDone: ok ? area.tileCount : (result.count ?? area.tilesDone),
    sizeBytes: result.downloaded ?? area.sizeBytes,
    errorMessage: ok ? undefined : (result.reason ?? "Download failed"),
    updatedAt: Date.now(),
  };
  saveArea(updated);
  await clearAreaResult(area.id);
  return updated;
}
