import { haversineMeters } from "@openmapx/core/utils/geo-server";
import {
  type ConflationPoint,
  type ConflationThresholds,
  conflate,
  DEFAULT_CONFLATION_THRESHOLDS,
} from "@openmapx/core/utils/poiConflation";
import { gridDisk, latLngToCell } from "h3-js";
import { sql } from "../../db/index.js";
import { cosineSimilarity, DEFAULT_MODEL, embed, ensureEmbeddingModel } from "./embeddings.js";
import { assertValidRegion, OVERTURE_RELEASE } from "./pull.js";
import { applyOsmPoisTable } from "./schema.js";

export interface OverturePlacePoint {
  gersId: string;
  name: string;
  lat: number;
  lng: number;
  h3_r8: string | null;
  category?: string;
  address?: string;
  confidence?: number;
}

export interface OsmPoiPoint {
  osm_type: string;
  osm_id: number;
  name: string;
  lat: number;
  lng: number;
  h3_r8?: string | null;
  category?: string;
}

export interface LinkRecord {
  osm_type: string;
  osm_id: number;
  gers_id: string;
  confidence: number;
  method: "spatial-name" | "embedding";
  release: string;
}

function ensureH3(point: { lat: number; lng: number; h3_r8?: string | null }): string {
  return point.h3_r8 ?? latLngToCell(point.lat, point.lng, 8);
}

/**
 * Computes OSM↔Overture link records using H3-r8 blocking, spatial-name
 * conflation, and optionally embedding-based residual matching.
 *
 * Step 1: Group both sets by H3 r8 cell. Use gridDisk(cell, 1) to include
 *         neighbors, avoiding split-cell boundary misses.
 * Step 2: For each shared-cell group, run the core `conflate` function.
 *         Matches become method: "spatial-name" links.
 * Step 3: For unmatched pairs within softWindowM, embed and accept cosine >
 *         cosineFloor as method: "embedding" links (only when embedFn provided).
 * Step 4: Dedup — per (osm_type, osm_id) and per gers_id keep best confidence.
 */
export async function computeLinks(
  places: OverturePlacePoint[],
  osmPois: OsmPoiPoint[],
  opts: {
    thresholds: ConflationThresholds;
    embedFn?: (texts: string[]) => Promise<number[][]>;
    cosineFloor?: number;
    release: string;
  },
): Promise<LinkRecord[]> {
  const { thresholds, embedFn, cosineFloor = 0.87, release } = opts;

  const overtureByCell = new Map<string, OverturePlacePoint[]>();
  for (const place of places) {
    const cell = ensureH3(place);
    const arr = overtureByCell.get(cell);
    if (arr) arr.push(place);
    else overtureByCell.set(cell, [place]);
  }

  const osmByCell = new Map<string, OsmPoiPoint[]>();
  for (const poi of osmPois) {
    const cell = ensureH3(poi);
    const arr = osmByCell.get(cell);
    if (arr) arr.push(poi);
    else osmByCell.set(cell, [poi]);
  }

  const spatialLinks: LinkRecord[] = [];
  const residualOsm = new Map<string, OsmPoiPoint>();
  const residualOverture = new Map<string, OverturePlacePoint>();

  const processedOsmCells = new Set<string>();

  for (const [osmCell, osmGroup] of osmByCell) {
    if (processedOsmCells.has(osmCell)) continue;
    processedOsmCells.add(osmCell);

    const neighborCells = gridDisk(osmCell, 1);
    const overtureGroup: OverturePlacePoint[] = [];
    for (const nc of neighborCells) {
      const pts = overtureByCell.get(nc);
      if (pts) overtureGroup.push(...pts);
    }

    if (overtureGroup.length === 0) {
      for (const poi of osmGroup) {
        residualOsm.set(`${poi.osm_type}:${poi.osm_id}`, poi);
      }
      continue;
    }

    const osmConflation: ConflationPoint[] = osmGroup.map((p) => ({
      id: `${p.osm_type}:${p.osm_id}`,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      category: p.category,
    }));

    const overtureConflation: ConflationPoint[] = overtureGroup.map((p) => ({
      id: p.gersId,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      category: p.category,
    }));

    const result = conflate(osmConflation, overtureConflation, thresholds);

    const osmGroupByKey = new Map<string, OsmPoiPoint>();
    for (const p of osmGroup) osmGroupByKey.set(`${p.osm_type}:${p.osm_id}`, p);
    const overtureGroupByKey = new Map<string, OverturePlacePoint>();
    for (const p of overtureGroup) overtureGroupByKey.set(p.gersId, p);

    for (const { a: osmPt, b: overturePt } of result.matched) {
      const osmPoi = osmGroupByKey.get(osmPt.id);
      const overturePl = overtureGroupByKey.get(overturePt.id);
      if (!osmPoi || !overturePl) continue;

      const confidence = overturePl.confidence ?? 0.9;
      spatialLinks.push({
        osm_type: osmPoi.osm_type,
        osm_id: osmPoi.osm_id,
        gers_id: overturePl.gersId,
        confidence,
        method: "spatial-name",
        release,
      });
    }

    for (const pt of result.unmatchedA) {
      const poi = osmGroupByKey.get(pt.id);
      if (poi) residualOsm.set(pt.id, poi);
    }
    for (const pt of result.unmatchedB) {
      const pl = overtureGroupByKey.get(pt.id);
      if (pl) residualOverture.set(pt.id, pl);
    }
  }

  const embeddingLinks: LinkRecord[] = [];

  if (embedFn && residualOsm.size > 0 && residualOverture.size > 0) {
    const osmArr = Array.from(residualOsm.values());
    const overtureArr = Array.from(residualOverture.values());

    const overtureByH3 = new Map<string, number[]>();
    for (let j = 0; j < overtureArr.length; j++) {
      const cell = latLngToCell(overtureArr[j].lat, overtureArr[j].lng, 8);
      const arr = overtureByH3.get(cell);
      if (arr) arr.push(j);
      else overtureByH3.set(cell, [j]);
    }

    const candidatePairs: Array<{ osmIdx: number; overtureIdx: number; dist: number }> = [];
    for (let i = 0; i < osmArr.length; i++) {
      const osmCell = latLngToCell(osmArr[i].lat, osmArr[i].lng, 8);
      const neighborCells = gridDisk(osmCell, 1);
      for (const nc of neighborCells) {
        const neighbors = overtureByH3.get(nc);
        if (!neighbors) continue;
        for (const j of neighbors) {
          const dist = haversineMeters(
            osmArr[i].lat,
            osmArr[i].lng,
            overtureArr[j].lat,
            overtureArr[j].lng,
          );
          if (dist <= thresholds.softWindowM) {
            candidatePairs.push({ osmIdx: i, overtureIdx: j, dist });
          }
        }
      }
    }

    if (candidatePairs.length > 0) {
      const uniqueOsmIndices = [...new Set(candidatePairs.map((p) => p.osmIdx))];
      const uniqueOvertureIndices = [...new Set(candidatePairs.map((p) => p.overtureIdx))];

      const osmTexts = uniqueOsmIndices.map((i) => osmArr[i].name);
      const overtureTexts = uniqueOvertureIndices.map((i) =>
        [overtureArr[i].name, overtureArr[i].address].filter(Boolean).join(" "),
      );

      const osmVecList = await embedFn(osmTexts);
      const overtureVecList = await embedFn(overtureTexts);

      const osmVecByIdx = new Map<number, number[]>();
      for (let k = 0; k < uniqueOsmIndices.length; k++) {
        osmVecByIdx.set(uniqueOsmIndices[k], osmVecList[k]);
      }
      const overtureVecByIdx = new Map<number, number[]>();
      for (let k = 0; k < uniqueOvertureIndices.length; k++) {
        overtureVecByIdx.set(uniqueOvertureIndices[k], overtureVecList[k]);
      }

      for (const { osmIdx, overtureIdx } of candidatePairs) {
        const osmVec = osmVecByIdx.get(osmIdx);
        const overtureVec = overtureVecByIdx.get(overtureIdx);
        if (!osmVec || !overtureVec) continue;
        const sim = cosineSimilarity(osmVec, overtureVec);
        if (sim > cosineFloor) {
          const osmPoi = osmArr[osmIdx];
          const overturePl = overtureArr[overtureIdx];
          embeddingLinks.push({
            osm_type: osmPoi.osm_type,
            osm_id: osmPoi.osm_id,
            gers_id: overturePl.gersId,
            confidence: sim * (overturePl.confidence ?? 0.9),
            method: "embedding",
            release,
          });
        }
      }
    }
  }

  const allLinks = [...spatialLinks, ...embeddingLinks];

  const bestByOsm = new Map<string, LinkRecord>();
  for (const link of allLinks) {
    const key = `${link.osm_type}:${link.osm_id}`;
    const existing = bestByOsm.get(key);
    if (!existing || link.confidence > existing.confidence) {
      bestByOsm.set(key, link);
    }
  }

  const bestByGers = new Map<string, LinkRecord>();
  for (const link of bestByOsm.values()) {
    const existing = bestByGers.get(link.gers_id);
    if (!existing || link.confidence > existing.confidence) {
      bestByGers.set(link.gers_id, link);
    }
  }

  return Array.from(bestByGers.values());
}

/**
 * Full conflation job: loads places and OSM POIs from the database, runs
 * computeLinks, then batch-upserts results into poi_conflation_link.
 */
export async function conflateOverture(opts: {
  region: string;
  release?: string;
  ollamaUrl?: string;
  useEmbeddings?: boolean;
  schema?: string;
  onProgress?: (msg: string) => void;
}): Promise<{ linked: number }> {
  assertValidRegion(opts.region);
  const { release = OVERTURE_RELEASE, ollamaUrl, useEmbeddings = false, onProgress } = opts;
  const schema = opts.schema ?? "overture_places";

  const placesRows = await sql.unsafe<
    {
      gers_id: string;
      name: string;
      lat: number;
      lng: number;
      h3_r8: string | null;
      category: string | null;
      addresses: unknown;
      confidence: number | null;
    }[]
  >(
    `SELECT gers_id,
            name,
            ST_Y(geom) AS lat,
            ST_X(geom) AS lng,
            h3_r8,
            openmapx_category AS category,
            addresses,
            confidence
     FROM "${schema}".places
     WHERE operating_status <> 'permanently_closed'
       AND (confidence IS NULL OR confidence >= 0.7)`,
    [],
  );

  const places: OverturePlacePoint[] = placesRows.map((r) => {
    let address: string | undefined;
    if (r.addresses && typeof r.addresses === "object") {
      const addrArr = r.addresses as Array<{ freeform?: string }>;
      address = addrArr[0]?.freeform ?? undefined;
    }
    return {
      gersId: r.gers_id,
      name: r.name,
      lat: Number(r.lat),
      lng: Number(r.lng),
      h3_r8: r.h3_r8,
      category: r.category ?? undefined,
      address,
      confidence: r.confidence ?? undefined,
    };
  });
  onProgress?.(`Loaded ${places.length} Overture places from DB.`);

  await applyOsmPoisTable(schema);

  const osmRows = await sql.unsafe<
    {
      osm_type: string;
      osm_id: string;
      name: string;
      lat: number;
      lng: number;
      category: string | null;
    }[]
  >(
    `SELECT osm_type, osm_id, name, lat, lng, category
     FROM "${schema}".osm_pois`,
    [],
  );

  const osmPois: OsmPoiPoint[] = osmRows.map((r) => ({
    osm_type: r.osm_type,
    osm_id: Number(r.osm_id),
    name: r.name,
    lat: Number(r.lat),
    lng: Number(r.lng),
    category: r.category ?? undefined,
  }));
  onProgress?.(`Loaded ${osmPois.length} OSM POIs from DB.`);

  if (useEmbeddings && ollamaUrl) {
    await ensureEmbeddingModel(DEFAULT_MODEL, ollamaUrl);
  }

  const embedFn = useEmbeddings ? (texts: string[]) => embed(texts, { ollamaUrl }) : undefined;

  onProgress?.(`Computing OSM↔Overture links…`);
  const links = await computeLinks(places, osmPois, {
    thresholds: DEFAULT_CONFLATION_THRESHOLDS,
    embedFn,
    release,
  });
  onProgress?.(`Computed ${links.length} candidate links.`);

  if (links.length === 0) {
    return { linked: 0 };
  }

  const COLS = 6;
  const rowsPerBatch = Math.floor(65500 / COLS);

  for (let i = 0; i < links.length; i += rowsPerBatch) {
    const batch = links.slice(i, i + rowsPerBatch);

    const placeholders = batch
      .map(
        (_, k) =>
          `($${k * COLS + 1}, $${k * COLS + 2}::BIGINT, $${k * COLS + 3}, $${k * COLS + 4}::DOUBLE PRECISION, $${k * COLS + 5}, $${k * COLS + 6})`,
      )
      .join(", ");

    const values = batch.flatMap((l) => [
      l.osm_type,
      l.osm_id,
      l.gers_id,
      l.confidence,
      l.method,
      l.release,
    ]);

    await sql.unsafe(
      `INSERT INTO "${schema}".poi_conflation_link
         (osm_type, osm_id, gers_id, confidence, method, release)
       VALUES ${placeholders}
       ON CONFLICT (osm_type, osm_id, gers_id)
       DO UPDATE SET
         confidence = EXCLUDED.confidence,
         method     = EXCLUDED.method,
         release    = EXCLUDED.release`,
      values,
    );
  }

  onProgress?.(`Upserted ${links.length} conflation links into poi_conflation_link.`);
  return { linked: links.length };
}
