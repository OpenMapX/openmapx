import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OFFLINE_PACKAGE_ALGORITHM_VERSION, type OfflinePackageBbox } from "@openmapx/core";
import type { OfflinePackageSourceCatalog } from "./types.js";

const SOURCE_RELATIVE_PATH = join("tile-mbtiles", "tiles.mbtiles");
const STYLE_VARIANTS = ["osm-bright", "dark-matter"] as const;
const DEFAULT_ATTRIBUTION = ["© OpenStreetMap contributors", "© OpenMapTiles"];

export type OfflinePackageSourceErrorReason = "source-unavailable" | "unsupported-provider";

export class OfflinePackageSourceError extends Error {
  readonly reason: OfflinePackageSourceErrorReason;

  constructor(reason: OfflinePackageSourceErrorReason, message: string) {
    super(message);
    this.name = "OfflinePackageSourceError";
    this.reason = reason;
  }
}

function parseMetadata(db: DatabaseSync): Map<string, string> {
  try {
    const rows = db.prepare("SELECT name, value FROM metadata").all() as Array<{
      name: string;
      value: string;
    }>;
    return new Map(rows.map((row) => [row.name, String(row.value)]));
  } catch (error) {
    throw new OfflinePackageSourceError(
      "source-unavailable",
      `MBTiles metadata could not be read: ${(error as Error).message}`,
    );
  }
}

function parseBounds(value: string | undefined): OfflinePackageBbox {
  const values = value?.split(",").map(Number);
  if (values?.length !== 4 || !values.every(Number.isFinite)) {
    throw new OfflinePackageSourceError("source-unavailable", "MBTiles bounds metadata is missing");
  }
  const [west, south, east, north] = values;
  if (west < -180 || east > 180 || south < -90 || north > 90 || east <= west || north <= south) {
    throw new OfflinePackageSourceError("source-unavailable", "MBTiles bounds metadata is invalid");
  }
  return { west, south, east, north };
}

function parseMaxZoom(value: string | undefined): number {
  const maxZoom = Number(value);
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 24) {
    throw new OfflinePackageSourceError(
      "source-unavailable",
      "MBTiles maxzoom metadata is invalid",
    );
  }
  return maxZoom;
}

function assertRegularPath(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new OfflinePackageSourceError("source-unavailable", `${label} does not exist: ${path}`);
  }
  try {
    if (!lstatSync(path).isFile()) {
      throw new OfflinePackageSourceError("source-unavailable", `${label} is not a regular file`);
    }
  } catch (error) {
    if (error instanceof OfflinePackageSourceError) throw error;
    throw new OfflinePackageSourceError("source-unavailable", `${label} cannot be inspected`);
  }
}

function collectVersionFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

function styleVersion(styleDirectory: string, dataDir: string): string {
  const hash = createHash("sha256");
  for (const variant of STYLE_VARIANTS) {
    const variantDirectory = join(styleDirectory, variant);
    for (const path of collectVersionFiles(variantDirectory)) {
      hash.update(relative(dataDir, path));
      hash.update(readFileSync(path));
    }
  }

  const fontsDirectory = join(dataDir, "tile-fonts");
  if (existsSync(fontsDirectory)) {
    for (const path of collectVersionFiles(fontsDirectory)) {
      hash.update(relative(dataDir, path));
      hash.update(readFileSync(path));
    }
  }
  return `openmapx-style-${hash.digest("hex").slice(0, 32)}`;
}

export function getOpenMapxPackageSource(
  dataDir = process.env.DATA_DIR ?? "/data",
): OfflinePackageSourceCatalog {
  const mbtilesPath = join(dataDir, SOURCE_RELATIVE_PATH);
  assertRegularPath(mbtilesPath, "OpenMapX MBTiles source");

  const styleDirectory = join(dataDir, "tile-styles");
  if (!existsSync(styleDirectory)) {
    throw new OfflinePackageSourceError(
      "source-unavailable",
      `OpenMapX style directory does not exist: ${styleDirectory}`,
    );
  }
  for (const variant of STYLE_VARIANTS) {
    const styleJson = join(styleDirectory, variant, "style.json");
    assertRegularPath(styleJson, `OpenMapX ${variant} style`);
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(mbtilesPath, { readOnly: true });
    const metadata = parseMetadata(db);
    const fileStat = statSync(mbtilesPath);
    const datasetLabel = metadata.get("version")?.trim() || "mbtiles";
    const datasetVersion = `${datasetLabel}-${fileStat.size}-${Math.trunc(fileStat.mtimeMs)}`;
    const descriptor = {
      datasetId: "openmapx" as const,
      datasetVersion,
      sourceMaxZoom: parseMaxZoom(metadata.get("maxzoom")),
      sourceBounds: parseBounds(metadata.get("bounds")),
      tileSchema: "openmaptiles" as const,
      styleProvider: "openmapx" as const,
      styleVersion: styleVersion(styleDirectory, dataDir),
      packageAlgorithmVersion: OFFLINE_PACKAGE_ALGORITHM_VERSION,
      attribution: [...DEFAULT_ATTRIBUTION],
    };
    return {
      descriptor,
      mbtilesPath,
      styleDirectory,
      packageRoot: join(dataDir, "offline-packages"),
    };
  } catch (error) {
    if (error instanceof OfflinePackageSourceError) throw error;
    throw new OfflinePackageSourceError(
      "source-unavailable",
      `OpenMapX MBTiles source could not be opened: ${(error as Error).message}`,
    );
  } finally {
    db?.close();
  }
}
