import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatasetMetadata, StateStore } from "../state.js";
import { curlAtomic } from "./atomic-download.js";

export function resolveOsmUrl(region: string): string {
  if (!region) throw new Error("region is required");
  if (region === "planet") {
    return "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf";
  }
  return `https://download.geofabrik.de/${region}-latest.osm.pbf`;
}

export interface DownloadOsmOptions {
  region: string;
  dataDir: string;
  store: StateStore;
  onProgress?: (bytesDownloaded: number, totalBytes?: number) => void;
}

export interface DownloadOsmResult {
  path: string;
  url: string;
  sizeBytes: number;
}

export async function downloadOsm(opts: DownloadOsmOptions): Promise<DownloadOsmResult> {
  const url = resolveOsmUrl(opts.region);
  const fileName =
    opts.region === "planet" ? "planet.osm.pbf" : `${opts.region.replace(/\//g, "-")}.osm.pbf`;
  const targetDir = join(opts.dataDir, "osm");
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, fileName);

  await curlAtomic(url, targetPath, { onProgress: opts.onProgress });

  const sizeBytes = statSync(targetPath).size;
  const meta: DatasetMetadata = {
    type: "osm-pbf",
    id: opts.region,
    region: opts.region,
    url,
    sizeBytes,
    downloadedAt: new Date().toISOString(),
    path: targetPath,
  };
  opts.store.upsert(meta);

  return { path: targetPath, url, sizeBytes };
}
