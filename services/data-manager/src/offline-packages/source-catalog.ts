import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OFFLINE_PACKAGE_ALGORITHM_VERSION, type OfflinePackageBbox } from "@openmapx/core";
import type { OfflinePackageSourceCatalog } from "./types.js";

const SOURCE_RELATIVE_PATH = join("tile-mbtiles", "tiles.mbtiles");
const DEFAULT_ATTRIBUTION = ["© OpenStreetMap contributors", "© OpenMapTiles"];

export type OfflinePackageSourceErrorReason = "source-unavailable";

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

function assertDirectoryPath(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new OfflinePackageSourceError("source-unavailable", `${label} does not exist: ${path}`);
  }
  try {
    if (!lstatSync(path).isDirectory()) {
      throw new OfflinePackageSourceError("source-unavailable", `${label} is not a directory`);
    }
  } catch (error) {
    if (error instanceof OfflinePackageSourceError) throw error;
    throw new OfflinePackageSourceError("source-unavailable", `${label} cannot be inspected`);
  }
}

function collectGlyphFiles(root: string): string[] {
  const files: string[] = [];
  for (const font of readdirSync(root, { withFileTypes: true })) {
    if (!font.isDirectory() || font.isSymbolicLink()) continue;
    const directory = join(root, font.name);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^\d+-\d+\.pbf$/.test(entry.name)) {
        files.push(join(directory, entry.name));
      }
    }
  }
  return files.sort();
}

function glyphsVersion(fontsDirectory: string, dataDir: string): string {
  const hash = createHash("sha256");
  const files = collectGlyphFiles(fontsDirectory);
  if (files.length === 0) {
    throw new OfflinePackageSourceError(
      "source-unavailable",
      `OpenMapX font directory contains no glyph PBF files: ${fontsDirectory}`,
    );
  }
  for (const path of files) {
    hash.update(relative(dataDir, path));
    hash.update(readFileSync(path));
  }
  return `openmapx-glyphs-${hash.digest("hex").slice(0, 32)}`;
}

export function getOpenMapxPackageSource(
  dataDir = process.env.DATA_DIR ?? "/data",
): OfflinePackageSourceCatalog {
  const mbtilesPath = join(dataDir, SOURCE_RELATIVE_PATH);
  assertRegularPath(mbtilesPath, "OpenMapX MBTiles source");

  const fontsDirectory = join(dataDir, "tile-fonts");
  assertDirectoryPath(fontsDirectory, "OpenMapX font directory");

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(mbtilesPath, { readOnly: true });
    const metadata = parseMetadata(db);
    const fileStat = statSync(mbtilesPath);
    const datasetLabel = metadata.get("version")?.trim() || "mbtiles";
    const datasetVersion = [
      datasetLabel,
      fileStat.size,
      Math.trunc(fileStat.mtimeMs),
      Math.trunc(fileStat.ctimeMs),
      fileStat.ino,
    ].join("-");
    const descriptor = {
      datasetId: "openmapx" as const,
      datasetVersion,
      sourceMaxZoom: parseMaxZoom(metadata.get("maxzoom")),
      sourceBounds: parseBounds(metadata.get("bounds")),
      tileSchema: "openmaptiles" as const,
      glyphsVersion: glyphsVersion(fontsDirectory, dataDir),
      packageAlgorithmVersion: OFFLINE_PACKAGE_ALGORITHM_VERSION,
      attribution: [...DEFAULT_ATTRIBUTION],
    };
    return {
      descriptor,
      mbtilesPath,
      fontsDirectory,
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

function sourcePathFingerprint(dataDir: string): string {
  const mbtilesPath = join(dataDir, SOURCE_RELATIVE_PATH);
  const fontsDirectory = join(dataDir, "tile-fonts");
  assertRegularPath(mbtilesPath, "OpenMapX MBTiles source");
  assertDirectoryPath(fontsDirectory, "OpenMapX font directory");
  const mbtiles = statSync(mbtilesPath);
  const fonts = statSync(fontsDirectory);
  return [
    mbtiles.dev,
    mbtiles.ino,
    mbtiles.size,
    Math.trunc(mbtiles.mtimeMs),
    Math.trunc(mbtiles.ctimeMs),
    fonts.dev,
    fonts.ino,
    Math.trunc(fonts.mtimeMs),
    Math.trunc(fonts.ctimeMs),
  ].join(":");
}

/**
 * Cache the content hashes until the atomically replaced MBTiles/font roots
 * change. Glyph requests otherwise re-hash the complete font tree per PBF.
 */
export function createOpenMapxPackageSourceFactory(
  dataDir = process.env.DATA_DIR ?? "/data",
): () => OfflinePackageSourceCatalog {
  let fingerprint: string | undefined;
  let source: OfflinePackageSourceCatalog | undefined;
  return () => {
    const nextFingerprint = sourcePathFingerprint(dataDir);
    if (source && fingerprint === nextFingerprint) return source;
    source = getOpenMapxPackageSource(dataDir);
    fingerprint = nextFingerprint;
    return source;
  };
}
