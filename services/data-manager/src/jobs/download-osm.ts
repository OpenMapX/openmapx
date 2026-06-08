import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { DatasetMetadata, StateStore } from "../state.js";
import { curlAtomic } from "./atomic-download.js";

export function resolveOsmUrl(region: string): string {
  if (!region) throw new Error("region is required");
  if (region === "planet") {
    return "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf";
  }
  return `https://download.geofabrik.de/${region}-latest.osm.pbf`;
}

/**
 * Local OSM PBF filename for a build region, matching the CLI's `osmPbfName`:
 * `planet` → `planet.osm.pbf`, otherwise the region with `/` → `-`
 * (e.g. `europe/germany` → `europe-germany.osm.pbf`).
 */
export function osmPbfName(region: string): string {
  return region === "planet" ? "planet.osm.pbf" : `${region.replace(/\//g, "-")}.osm.pbf`;
}

/**
 * Both Geofabrik (per-region) and planet.openstreetmap.org publish a
 * sibling `.md5` file next to every PBF containing `<hex>  <filename>`.
 * Returning it lets `downloadOsm` verify the file landed intact — a
 * truncated or corrupted PBF will surface at download time instead of
 * later when an OSRM/Valhalla build fails with a confusing error.
 */
export function resolveOsmMd5Url(osmUrl: string): string {
  return `${osmUrl}.md5`;
}

function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function fetchExpectedMd5(url: string): Promise<string | null> {
  try {
    const { stdout } = await execa("curl", ["-fsSL", url], { timeout: 30_000 });
    // `<md5>  <filename>` — take the first whitespace-delimited token.
    const token = stdout.trim().split(/\s+/)[0];
    if (token && /^[0-9a-f]{32}$/i.test(token)) return token.toLowerCase();
  } catch {
    // Sidecar not published or curl failed; treat as "no verification available".
  }
  return null;
}

export interface DownloadOsmOptions {
  region: string;
  dataDir: string;
  store: StateStore;
  onProgress?: (bytesDownloaded: number, totalBytes?: number) => void;
  /**
   * Set to false to skip the `.md5` sidecar fetch + hash verification. Only
   * useful for tests where the upstream server isn't reachable; production
   * callers should leave it enabled.
   */
  verifyChecksum?: boolean;
}

export interface DownloadOsmResult {
  path: string;
  url: string;
  sizeBytes: number;
  md5?: string;
}

export async function downloadOsm(opts: DownloadOsmOptions): Promise<DownloadOsmResult> {
  const url = resolveOsmUrl(opts.region);
  const fileName = osmPbfName(opts.region);
  const targetDir = join(opts.dataDir, "osm");
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, fileName);

  await curlAtomic(url, targetPath, { onProgress: opts.onProgress });

  const sizeBytes = statSync(targetPath).size;

  let md5: string | undefined;
  if (opts.verifyChecksum !== false) {
    const expected = await fetchExpectedMd5(resolveOsmMd5Url(url));
    if (expected) {
      const actual = await computeMd5(targetPath);
      if (actual !== expected) {
        throw new Error(
          `OSM PBF checksum mismatch for ${opts.region}: expected ${expected}, got ${actual}. The download is corrupt — re-run to retry.`,
        );
      }
      md5 = actual;
    }
  }

  const meta: DatasetMetadata = {
    type: "osm-pbf",
    id: opts.region,
    region: opts.region,
    url,
    sizeBytes,
    downloadedAt: new Date().toISOString(),
    path: targetPath,
    ...(md5 ? { md5 } : {}),
  };
  opts.store.upsert(meta);

  return { path: targetPath, url, sizeBytes, ...(md5 ? { md5 } : {}) };
}
