import { existsSync, readFileSync } from "node:fs";

/**
 * One operator-local patch into the Transitous feed catalog. `region`
 * identifies the catalog filename (without the `.json` extension, e.g.
 * `de` matches `feeds/de.json`), `name` identifies a source within that
 * region by its `sources[*].name`, and `patch` is a shallow object of
 * fields to merge into that source.
 */
export interface FeedOverlayPatch {
  region: string;
  name: string;
  patch: Record<string, unknown>;
}

export interface FeedOverlay {
  patches: FeedOverlayPatch[];
}

export interface FeedOverlayApplyResult {
  applied: number;
  unmatched: FeedOverlayPatch[];
}

interface FeedSource {
  name?: string;
  [key: string]: unknown;
}

export interface FeedFile {
  region: string;
  sources?: FeedSource[];
  [key: string]: unknown;
}

/**
 * Read `feeds-overlay.json` from disk. Returns `null` when the file is
 * absent (pipeline must continue unaffected — overlay is optional).
 *
 * The on-disk format is plain JSON; documentation lives in a top-level
 * `comment` field so the file roundtrips through any JSON parser without
 * needing JSONC support.
 */
export function readFeedOverlay(path: string): FeedOverlay | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse feeds overlay at ${path}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Feeds overlay at ${path} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const patchesRaw = obj.patches;
  if (patchesRaw === undefined) return { patches: [] };
  if (!Array.isArray(patchesRaw)) {
    throw new Error(`Feeds overlay at ${path} has a non-array "patches" field`);
  }
  const patches: FeedOverlayPatch[] = [];
  for (const [index, entry] of patchesRaw.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Feeds overlay patch #${index} at ${path} is not an object`);
    }
    const patchObj = entry as Record<string, unknown>;
    if (typeof patchObj.region !== "string" || !patchObj.region) {
      throw new Error(`Feeds overlay patch #${index} at ${path} is missing string "region"`);
    }
    if (typeof patchObj.name !== "string" || !patchObj.name) {
      throw new Error(`Feeds overlay patch #${index} at ${path} is missing string "name"`);
    }
    if (!patchObj.patch || typeof patchObj.patch !== "object" || Array.isArray(patchObj.patch)) {
      throw new Error(`Feeds overlay patch #${index} at ${path} is missing object "patch"`);
    }
    patches.push({
      region: patchObj.region,
      name: patchObj.name,
      patch: { ...(patchObj.patch as Record<string, unknown>) },
    });
  }
  return { patches };
}

/**
 * Apply an in-memory overlay to a list of feed files. Each patch is
 * matched against `(feed.region, source.name)`; matching sources are
 * shallow-merged with the patch values. Patches with no matching feed
 * or source are returned as `unmatched` so the caller can log them —
 * they are intentionally silent no-ops to keep the pipeline robust
 * against catalog drift between bumps.
 */
export function applyFeedOverlay(feeds: FeedFile[], overlay: FeedOverlay): FeedOverlayApplyResult {
  let applied = 0;
  const unmatched: FeedOverlayPatch[] = [];
  for (const patch of overlay.patches) {
    const feed = feeds.find((entry) => entry.region === patch.region);
    if (!feed) {
      unmatched.push(patch);
      continue;
    }
    const sources = feed.sources;
    if (!Array.isArray(sources)) {
      unmatched.push(patch);
      continue;
    }
    let matchedInFeed = false;
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      if (source.name !== patch.name) continue;
      for (const [key, value] of Object.entries(patch.patch)) {
        source[key] = value;
      }
      matchedInFeed = true;
      applied++;
    }
    if (!matchedInFeed) unmatched.push(patch);
  }
  return { applied, unmatched };
}
