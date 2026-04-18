import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { DatasetMetadata, StateStore } from "../state.js";

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

  await execa("curl", ["-fSL", "-o", targetPath, url], { stdio: "inherit" });

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
