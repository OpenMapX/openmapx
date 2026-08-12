import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { execa } from "execa";
import { osmPbfName } from "../download-osm.js";
import { assertValidRegion } from "../overture/pull.js";
import {
  deriveCategory,
  deriveImportance,
  extractTerms,
  isSearchableFeature,
  type OsmTags,
  type SearchTerm,
} from "./terms.js";

export interface SearchPlaceRecord {
  osmType: "node" | "way" | "relation";
  osmId: string;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  tags: OsmTags;
  importance: number;
  terms: SearchTerm[];
}

export interface SearchGeoJsonFeature {
  type?: string;
  id?: string;
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
}

function sourceIdentity(
  feature: SearchGeoJsonFeature,
): Pick<SearchPlaceRecord, "osmType" | "osmId"> | null {
  const type = feature.properties?.["@type"];
  const id = feature.properties?.["@id"];
  if (
    (type === "node" || type === "way" || type === "relation") &&
    /^(?:-?\d+)$/.test(String(id))
  ) {
    return { osmType: type, osmId: String(id) };
  }
  const match = /^([nwr])(-?\d+)$/.exec(feature.id ?? "");
  if (!match) return null;
  return {
    osmType: match[1] === "n" ? "node" : match[1] === "w" ? "way" : "relation",
    osmId: match[2],
  };
}

function representativePoint(geometry: {
  type: string;
  coordinates: unknown;
}): [number, number] | null {
  if (geometry.type === "Point") return geometry.coordinates as [number, number];
  let points: number[][] = [];
  if (geometry.type === "LineString") points = geometry.coordinates as number[][];
  if (geometry.type === "Polygon") points = (geometry.coordinates as number[][][])[0] ?? [];
  if (geometry.type === "MultiPolygon")
    points = (geometry.coordinates as number[][][][])[0]?.[0] ?? [];
  if (points.length === 0) return null;
  let sin = 0;
  let cos = 0;
  let lat = 0;
  for (const [lngValue, latValue] of points) {
    sin += Math.sin((lngValue * Math.PI) / 180);
    cos += Math.cos((lngValue * Math.PI) / 180);
    lat += latValue;
  }
  return [
    (Math.atan2(sin / points.length, cos / points.length) * 180) / Math.PI,
    lat / points.length,
  ];
}

export function featureToSearchPlace(feature: SearchGeoJsonFeature): SearchPlaceRecord | null {
  const tags = Object.fromEntries(
    Object.entries(feature.properties ?? {}).filter(
      ([key, value]) => !key.startsWith("@") && typeof value === "string",
    ),
  ) as OsmTags;
  if (!isSearchableFeature(tags) || !feature.geometry) return null;
  const identity = sourceIdentity(feature);
  const point = representativePoint(feature.geometry);
  if (!identity || !point) return null;
  const [lng, lat] = point;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  )
    return null;
  const terms = extractTerms(tags);
  if (terms.length === 0) return null;
  return {
    ...identity,
    name: tags.name.trim(),
    lat,
    lng,
    category: deriveCategory(tags),
    tags,
    importance: deriveImportance(tags),
    terms,
  };
}

export interface ExtractSearchPlacesOptions {
  dataDir: string;
  region: string;
  pbfPath?: string;
  onBatch: (records: SearchPlaceRecord[]) => Promise<void>;
  onProgress?: (message: string) => void;
  onCheckpoint?: (extracted: number) => Promise<void>;
}

export async function extractSearchPlaces(
  opts: ExtractSearchPlacesOptions,
): Promise<{ emitted: number; extracted: number }> {
  assertValidRegion(opts.region);
  const pbfPath = opts.pbfPath ?? join(opts.dataDir, "osm", osmPbfName(opts.region));
  const tempDir = join(opts.dataDir, "search-index", "extract");
  const filteredPbf = join(tempDir, `${opts.region.replace(/\//g, "-")}-named.osm.pbf`);
  mkdirSync(tempDir, { recursive: true });
  try {
    opts.onProgress?.(`Filtering named OSM features from ${pbfPath}`);
    await execa("osmium", ["tags-filter", pbfPath, "nwr/name", "-o", filteredPbf, "-O"], {
      stdio: "inherit",
    });
    const process = execa(
      "osmium",
      [
        "export",
        "-f",
        "geojsonseq",
        "--add-unique-id=type_id",
        "--attributes=type,id",
        filteredPbf,
      ],
      {
        stdout: "pipe",
        stderr: "inherit",
        buffer: false,
      },
    );
    if (!process.stdout) throw new Error("osmium export did not provide a stdout stream");
    const lines = createInterface({ input: process.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    let emitted = 0;
    let extracted = 0;
    let batch: SearchPlaceRecord[] = [];
    try {
      for await (const raw of lines) {
        const line = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim();
        if (!line) continue;
        emitted += 1;
        let feature: SearchGeoJsonFeature;
        try {
          feature = JSON.parse(line) as SearchGeoJsonFeature;
        } catch {
          continue;
        }
        const record = featureToSearchPlace(feature);
        if (!record) continue;
        batch.push(record);
        extracted += 1;
        if (batch.length >= 1_000) {
          await opts.onBatch(batch);
          batch = [];
          await opts.onCheckpoint?.(extracted);
        }
      }
      if (batch.length) await opts.onBatch(batch);
      await process;
    } catch (error) {
      process.kill("SIGTERM");
      await process.catch(() => undefined);
      throw error;
    } finally {
      lines.close();
    }
    return { emitted, extracted };
  } finally {
    rmSync(filteredPbf, { force: true });
  }
}
