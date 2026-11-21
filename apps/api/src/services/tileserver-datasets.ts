import { serviceUrl } from "./service-registry";

/** Which archives the local tileserver serves right now. */
export interface TileserverDatasets {
  basemap: boolean;
  streetDetail: boolean;
}

const PROBE_TIMEOUT_MS = 1_000;
const CACHE_MS = 60_000;
/** A failed probe is retried soon rather than remembered for a minute. */
const FAILURE_CACHE_MS = 5_000;

let cached: { at: number; ttl: number; value: Promise<TileserverDatasets | null> } | null = null;
let lastGood: TileserverDatasets | null = null;

/** True for 200, false only for a definite 404; anything else leaves the answer unknown. */
async function served(base: string, dataset: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(`${base}/data/${dataset}.json`, { signal, redirect: "error" });
  await response.body?.cancel();
  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`Tileserver answered ${response.status} for ${dataset}`);
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
    lastGood = { basemap, streetDetail };
    return lastGood;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the tileserver which archives it serves: hosted-basemap builds have no
 * basemap, builds from before street detail have no street detail. Null
 * without a tileserver, or while it cannot be asked and has never answered;
 * a tileserver that answered before keeps its last answer through a restart
 * or a slow moment. Answers are cached for a minute, failures for 5 s.
 */
export function tileserverDatasets(): Promise<TileserverDatasets | null> {
  const now = Date.now();
  if (!cached || now - cached.at > cached.ttl) {
    const entry: { at: number; ttl: number; value: Promise<TileserverDatasets | null> } = {
      at: now,
      ttl: CACHE_MS,
      value: probe().catch(() => {
        entry.ttl = FAILURE_CACHE_MS;
        return lastGood;
      }),
    };
    cached = entry;
  }
  return cached.value;
}

/** Forget the cached and last good answers (tests). */
export function resetTileserverDatasets(): void {
  cached = null;
  lastGood = null;
}
