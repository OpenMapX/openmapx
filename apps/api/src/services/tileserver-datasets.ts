import { serviceUrl } from "./service-registry";

/** Which archives the local tileserver serves right now. */
export interface TileserverDatasets {
  basemap: boolean;
  streetDetail: boolean;
}

const PROBE_TIMEOUT_MS = 1_000;
const CACHE_MS = 60_000;

let cached: { at: number; value: Promise<TileserverDatasets | null> } | null = null;

async function served(base: string, dataset: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(`${base}/data/${dataset}.json`, { signal, redirect: "error" });
  await response.body?.cancel();
  return response.ok;
}

async function probe(): Promise<TileserverDatasets | null> {
  const base = serviceUrl("tileserver");
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const [basemap, streetDetail] = await Promise.all([
      served(base, "openmapx", controller.signal),
      served(base, "street_detail", controller.signal),
    ]);
    return { basemap, streetDetail };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the tileserver which archives it serves: hosted-basemap builds have no
 * basemap, builds from before street detail have no street detail. Null
 * without a tileserver or while it is unreachable. Cached for a minute, so the
 * public map-config route probes at most once per window.
 */
export function tileserverDatasets(): Promise<TileserverDatasets | null> {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) cached = { at: now, value: probe() };
  return cached.value;
}

/** Forget the cached answer (tests). */
export function resetTileserverDatasets(): void {
  cached = null;
}
