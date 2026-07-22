import type {
  StreetLevelArrow,
  StreetLevelImage,
  StreetLevelLink,
  StreetLevelRef,
} from "@openmapx/core";
import { formatStreetLevelRef, selectArrowLinks } from "@openmapx/core";

export interface StreetLevelNode {
  /** Composite ref string; doubles as the Photo Sphere Viewer node id. */
  id: string;
  image: StreetLevelImage;
  arrows: StreetLevelArrow[];
}

/** Provider ids and integration ids differ by a fixed prefix. */
export function integrationIdFor(providerId: string): string {
  return `street-level-imagery-${providerId}`;
}

/**
 * In-flight and very recently resolved nodes, keyed by composite ref.
 *
 * Each hop is requested twice — once by the virtual-tour plugin's `getNode`
 * and once by the React effect that mirrors the store — and each provider
 * request costs two upstream calls. Sharing the promise collapses that back to
 * one round trip per image.
 *
 * Entries are deliberately short-lived. Some providers hand out expiring signed
 * asset URLs (Mapillary's `thumb_*_url` are Meta CDN links), so a node held for
 * the life of a long-running map tab would eventually resolve instantly to URLs
 * that 403 — and, having resolved, would never evict itself. Collapsing the
 * duplicate fetch only needs a few seconds of sharing.
 */
const NODE_CACHE_TTL_MS = 30_000;
const NODE_CACHE_LIMIT = 50;

interface CacheEntry {
  promise: Promise<StreetLevelNode>;
  /** Wall-clock time the entry settled; Infinity while still in flight. */
  settledAt: number;
}

const nodeCache = new Map<string, CacheEntry>();

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.settledAt < NODE_CACHE_TTL_MS;
}

function remember(key: string, promise: Promise<StreetLevelNode>): Promise<StreetLevelNode> {
  const entry: CacheEntry = { promise, settledAt: Number.POSITIVE_INFINITY };
  nodeCache.set(key, entry);

  if (nodeCache.size > NODE_CACHE_LIMIT) {
    const oldest = nodeCache.keys().next().value;
    if (oldest !== undefined) nodeCache.delete(oldest);
  }

  promise.then(
    () => {
      entry.settledAt = Date.now();
    },
    // A failed lookup must not be cached, or the viewer could never recover.
    () => nodeCache.delete(key),
  );

  return promise;
}

async function loadStreetLevelNode(apiUrl: string, ref: StreetLevelRef): Promise<StreetLevelNode> {
  const base = `${apiUrl}/api/integrations/${integrationIdFor(ref.providerId)}/images/${encodeURIComponent(ref.imageId)}`;

  const [imageResponse, linksResponse] = await Promise.all([fetch(base), fetch(`${base}/links`)]);

  if (!imageResponse.ok) {
    throw new Error(`Street-level image unavailable: ${ref.providerId}:${ref.imageId}`);
  }

  const image = (await imageResponse.json()) as StreetLevelImage;
  const links = linksResponse.ok ? ((await linksResponse.json()) as StreetLevelLink[]) : [];

  return {
    id: formatStreetLevelRef(ref),
    image,
    arrows: selectArrowLinks(image.lngLat, links),
  };
}

export function fetchStreetLevelNode(
  apiUrl: string,
  ref: StreetLevelRef,
): Promise<StreetLevelNode> {
  const key = `${apiUrl}|${formatStreetLevelRef(ref)}`;
  const cached = nodeCache.get(key);
  if (cached && isFresh(cached)) return cached.promise;
  if (cached) nodeCache.delete(key);
  return remember(key, loadStreetLevelNode(apiUrl, ref));
}

/** Test seam — the cache is module state and would otherwise leak between cases. */
export function clearStreetLevelNodeCache(): void {
  nodeCache.clear();
}
