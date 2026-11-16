import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type DataFileIdentity, hashDataFile } from "@openmapx/core/build-artifacts";
import { execa } from "execa";
import { jobChildLogger } from "../logger.js";
import type { DatasetMetadata, StateStore } from "../state.js";
import { type OsmPbfHeader, tryReadOsmPbfHeader } from "../utils/osm-pbf-header.js";
import {
  type CurlAtomicOptions,
  type CurlAtomicResult,
  curlAtomicWithResult,
} from "./atomic-download.js";
import { publishOsmFingerprint } from "./osm-fingerprints.js";

export function resolveOsmUrl(region: string): string {
  if (!region) throw new Error("region is required");
  if (region === "planet") {
    return "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf";
  }
  return `https://download.geofabrik.de/${region}-latest.osm.pbf`;
}

/**
 * Geofabrik publishes a `.poly` boundary file next to every region's PBF (e.g.
 * `europe/germany/berlin.poly`). It's a few KB and is the authoritative source
 * for a region's extent — used to derive the Overture pull bbox without
 * hardcoding per-region coordinates. Region identifiers are Geofabrik paths.
 */
export function resolveOsmPolyUrl(region: string): string {
  if (!region) throw new Error("region is required");
  if (region === "planet") {
    throw new Error("planet has no Geofabrik .poly boundary; specify a Geofabrik region");
  }
  return `https://download.geofabrik.de/${region}.poly`;
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

const MD5_RETRY_DELAYS_MS = [2_000, 5_000] as const;

/**
 * Fetch the `.md5` sidecar. Returns `null` only when the mirror answers that
 * the file does not exist: 404, 410, or 403, which object storage returns for
 * a missing key. Network failures, timeouts and other HTTP statuses are
 * retried and then thrown, so a transient failure can never disable
 * verification of the PBF that follows. A 2xx body that is not an MD5 sidecar
 * throws without retrying.
 */
export async function fetchExpectedMd5(
  url: string,
  opts: { signal?: AbortSignal; retryDelaysMs?: readonly number[] } = {},
): Promise<string | null> {
  const delays = opts.retryDelaysMs ?? MD5_RETRY_DELAYS_MS;
  let lastFailure = "";
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1], undefined, { signal: opts.signal });
    opts.signal?.throwIfAborted();
    let stdout: string;
    try {
      ({ stdout } = await execa(
        "curl",
        ["-sSL", "--connect-timeout", "10", "-w", "\n%{http_code}", url],
        { timeout: 30_000, cancelSignal: opts.signal },
      ));
    } catch (error) {
      opts.signal?.throwIfAborted();
      lastError = error;
      lastFailure = "request failed";
      continue;
    }
    const cut = stdout.lastIndexOf("\n");
    const status = Number(stdout.slice(cut + 1));
    if (status === 404 || status === 410 || status === 403) return null;
    if (status >= 200 && status < 300) {
      // `<md5>  <filename>` — take the first whitespace-delimited token.
      const token = stdout.slice(0, cut).trim().split(/\s+/)[0];
      if (token && /^[0-9a-f]{32}$/i.test(token)) return token.toLowerCase();
      throw new Error(
        `OSM PBF checksum file ${url} is not a valid MD5 sidecar; refusing to download unverified data.`,
      );
    }
    lastError = undefined;
    lastFailure = `HTTP ${status}`;
  }
  throw new Error(
    `Could not fetch the OSM PBF checksum from ${url} after ${delays.length + 1} attempts (${lastFailure}); refusing to download unverified data. Re-run to retry.`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

export interface DownloadOsmOptions {
  signal?: AbortSignal;
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
  /** Serializes only publication of a validated temp snapshot. */
  withPublishLock?: CurlAtomicOptions["withPublishLock"];
  /** Test seam for the staged downloader. */
  downloadImpl?: (
    url: string,
    targetPath: string,
    options: CurlAtomicOptions,
  ) => Promise<CurlAtomicResult>;
  /** Test seam for the `.md5` sidecar fetch. */
  checksumImpl?: (url: string, signal?: AbortSignal) => Promise<string | null>;
}

export interface DownloadOsmResult {
  path: string;
  url: string;
  sizeBytes: number;
  md5?: string;
}

/** The dataset fields an OSM PBF's header supplies. */
function headerFields(
  header: OsmPbfHeader,
): Pick<DatasetMetadata, "osmTimestamp" | "osmReplicationUrl"> {
  return {
    ...(header.timestamp ? { osmTimestamp: header.timestamp } : {}),
    ...(header.replicationUrl ? { osmReplicationUrl: header.replicationUrl } : {}),
  };
}

export async function downloadOsm(opts: DownloadOsmOptions): Promise<DownloadOsmResult> {
  opts.signal?.throwIfAborted();
  const url = resolveOsmUrl(opts.region);
  const fileName = osmPbfName(opts.region);
  const targetDir = join(opts.dataDir, "osm");
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const targetPath = join(targetDir, fileName);

  let md5: string | undefined;
  let sha256: string | undefined;
  let source: DataFileIdentity | undefined;
  let expected: string | null = null;
  if (opts.verifyChecksum !== false) {
    const md5Url = resolveOsmMd5Url(url);
    expected = await (opts.checksumImpl ?? ((u, signal) => fetchExpectedMd5(u, { signal })))(
      md5Url,
      opts.signal,
    );
    if (expected === null) {
      jobChildLogger({ job: "download-osm", region: opts.region }).warn(
        { md5Url },
        "download-osm: mirror publishes no .md5 checksum; downloading without integrity verification",
      );
    }
  }
  const download = opts.downloadImpl ?? curlAtomicWithResult;
  const result = await download(url, targetPath, {
    signal: opts.signal,
    publication: "data-output",
    onProgress: opts.onProgress,
    withPublishLock: async (publish) => {
      const commit = () => {
        publish();
        if (!sha256 || !source) throw Error("OSM source checksum missing");
        publishOsmFingerprint(targetPath, opts.region, sha256, source, true);
      };
      if (opts.withPublishLock) await opts.withPublishLock(commit);
      else commit();
    },
    beforePublish: async (tempPath) => {
      const checksums = await hashDataFile(tempPath, opts.signal);
      sha256 = checksums.sha256;
      source = checksums;
      if (expected) {
        const actual = checksums.md5;
        if (actual !== expected) {
          throw new Error(
            `OSM PBF checksum mismatch for ${opts.region}: expected ${expected}, got ${actual}. The download is corrupt — re-run to retry.`,
          );
        }
        md5 = actual;
      }
    },
  });

  // A 304 has no temp file to validate, so retain the previous behavior of
  // verifying the already-published target against the current sidecar.
  if (!result.published) {
    const checksums = await hashDataFile(targetPath, opts.signal);
    const actual = checksums.md5;
    sha256 = checksums.sha256;
    if (expected && actual !== expected) {
      throw new Error(
        `OSM PBF checksum mismatch for ${opts.region}: expected ${expected}, got ${actual}. The download is corrupt — re-run to retry.`,
      );
    }
    if (expected) md5 = actual;
    const record = () =>
      publishOsmFingerprint(targetPath, opts.region, checksums.sha256, checksums);
    if (opts.withPublishLock) await opts.withPublishLock(record);
    else record();
  }

  const sizeBytes = statSync(targetPath).size;

  const meta: DatasetMetadata = {
    type: "osm-pbf",
    id: opts.region,
    region: opts.region,
    url,
    sizeBytes,
    downloadedAt: new Date().toISOString(),
    path: targetPath,
    ...(md5 ? { md5 } : {}),
    ...headerFields(tryReadOsmPbfHeader(targetPath)),
  };
  opts.store.upsert(meta);

  return { path: targetPath, url, sizeBytes, ...(md5 ? { md5 } : {}) };
}
