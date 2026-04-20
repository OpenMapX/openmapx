import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

function osmFilenameForRegion(region: string): string {
  return region === "planet" ? "planet.osm.pbf" : `${region.replace(/\//g, "-")}.osm.pbf`;
}

export function resolveOsmPbf(
  dataDir: string,
  region: string | undefined,
  consumerName: string,
): string {
  const osmDir = join(dataDir, "osm");
  if (region) {
    const path = join(osmDir, osmFilenameForRegion(region));
    if (!existsSync(path)) {
      throw new Error(
        `No OSM PBF found for region "${region}" at ${path}. Run \`openmapx data download osm ${region}\` first.`,
      );
    }
    return path;
  }

  const candidates = existsSync(osmDir)
    ? readdirSync(osmDir)
        .filter((name) => name.endsWith(".osm.pbf"))
        .map((name) => join(osmDir, name))
        .filter((path) => statSync(path).isFile())
    : [];

  if (candidates.length === 0) {
    throw new Error(
      `No OSM PBF files found in ${osmDir}. Run \`openmapx data download osm <region>\` first.`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple OSM PBF files found (${candidates.map((p) => basename(p)).join(", ")}). Pass a region to choose which one to build for ${consumerName}.`,
    );
  }

  const only = candidates[0];
  if (!only) throw new Error(`No OSM PBF files found in ${osmDir}`);
  return only;
}
