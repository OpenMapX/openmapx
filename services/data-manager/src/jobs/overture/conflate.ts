import { overtureTaxonomyToOpenMapX } from "@openmapx/core";
import {
  haversineMeters,
  nameSimilarity,
  osmAddressKey,
  overtureAddressKey,
  parsePhones,
  websiteDomain,
} from "@openmapx/core/utils/geo-server";
import {
  assignConflationPairs,
  type ConflationMethod,
  type ConflationPoint,
  type ConflationThresholds,
  DEFAULT_CONFLATION_THRESHOLDS,
  type ScoredConflationPair,
  scoreConflationPair,
} from "@openmapx/core/utils/poiConflation";
import { gridDisk, latLngToCell } from "h3-js";
import { sql } from "../../db/index.js";
import { cosineSimilarity, DEFAULT_MODEL, embed, ensureEmbeddingModel } from "./embeddings.js";
import { assertValidRegion, resolveOvertureRelease } from "./pull.js";
import { applyOsmPoisTable } from "./schema.js";

// Overture confidence floor for conflation candidates. Calibrated to 0.5 (vs
// the earlier provisional 0.7) by the precision sweep: 0.7 excluded ~99.8% of
// Berlin places — including most genuine ones — starving the matcher. NULL
// confidence is always kept. A literal (not a parameter) interpolated into SQL.
const MIN_CONFLATE_CONFIDENCE = 0.5;

export interface OverturePlacePoint {
  gersId: string;
  name: string;
  lat: number;
  lng: number;
  h3_r8: string | null;
  category?: string;
  address?: string;
  confidence?: number;
  addressKey?: string;
  wikidata?: string;
  phones?: string[];
  website?: string;
}

export interface OsmPoiPoint {
  osm_type: string;
  osm_id: number;
  name: string;
  lat: number;
  lng: number;
  h3_r8?: string | null;
  category?: string;
  addressKey?: string;
  wikidata?: string;
  phones?: string[];
  website?: string;
}

export interface LinkRecord {
  osm_type: string;
  osm_id: number;
  gers_id: string;
  source_confidence: number | null;
  match_confidence: number;
  distance_m: number;
  method: ConflationMethod;
  evidence: {
    nameSimilarity: number;
    categoryCompatible: boolean;
    signals: string[];
  };
  release: string;
}

interface CandidatePair {
  osm: ConflationPoint;
  place: ConflationPoint;
  distanceM: number;
}

function ensureH3(point: { lat: number; lng: number; h3_r8?: string | null }): string {
  return point.h3_r8 ?? latLngToCell(point.lat, point.lng, 8);
}

/**
 * Computes OSM↔Overture link records using one region-wide candidate graph.
 *
 * Step 1: Generate every candidate edge exactly once using H3-r8 ring-1
 *         blocking and the configured distance window.
 * Step 2: Add explainable structured scores and optional embedding scores where
 *         no phone/address/wikidata/category evidence contradicts the match.
 * Step 3: Assign the complete graph globally, one-to-one, maximizing cardinality
 *         first and total identity confidence second.
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
  const osmById = new Map<string, { source: OsmPoiPoint; point: ConflationPoint }>();
  for (const source of osmPois) {
    const id = `${source.osm_type}:${source.osm_id}`;
    osmById.set(id, { source, point: { id, ...source } });
  }

  const placeById = new Map<string, { source: OverturePlacePoint; point: ConflationPoint }>();
  const placesByCell = new Map<string, OverturePlacePoint[]>();
  for (const source of places) {
    placeById.set(source.gersId, { source, point: { id: source.gersId, ...source } });
    const cell = ensureH3(source);
    const bucket = placesByCell.get(cell);
    if (bucket) bucket.push(source);
    else placesByCell.set(cell, [source]);
  }

  const candidates = new Map<string, CandidatePair>();
  for (const { source: osmSource, point: osm } of osmById.values()) {
    for (const cell of gridDisk(ensureH3(osmSource), 1)) {
      for (const placeSource of placesByCell.get(cell) ?? []) {
        const place = placeById.get(placeSource.gersId)?.point;
        if (!place) continue;
        const distanceM = haversineMeters(osm.lat, osm.lng, place.lat, place.lng);
        if (distanceM > thresholds.softWindowM) continue;
        candidates.set(`${osm.id}\u0000${place.id}`, { osm, place, distanceM });
      }
    }
  }

  const edges: ScoredConflationPair[] = [];
  const embeddingCandidates: CandidatePair[] = [];
  for (const candidate of candidates.values()) {
    const score = scoreConflationPair(candidate.osm, candidate.place, thresholds);
    if (score) {
      edges.push({ a: candidate.osm, b: candidate.place, score });
      continue;
    }
    const osmPhones = candidate.osm.phones ?? [];
    const placePhones = candidate.place.phones ?? [];
    const phoneConflict =
      osmPhones.length > 0 &&
      placePhones.length > 0 &&
      !osmPhones.some((phone) => placePhones.includes(phone));
    const addressConflict =
      candidate.osm.addressKey !== undefined &&
      candidate.place.addressKey !== undefined &&
      candidate.osm.addressKey !== candidate.place.addressKey;
    const wikidataConflict =
      candidate.osm.wikidata !== undefined &&
      candidate.place.wikidata !== undefined &&
      candidate.osm.wikidata !== candidate.place.wikidata;
    const categoryConflict =
      candidate.osm.category !== undefined &&
      candidate.place.category !== undefined &&
      candidate.osm.category !== candidate.place.category;
    if (!phoneConflict && !addressConflict && !wikidataConflict && !categoryConflict) {
      embeddingCandidates.push(candidate);
    }
  }

  if (embedFn && embeddingCandidates.length > 0) {
    const osmIds = [...new Set(embeddingCandidates.map((candidate) => candidate.osm.id))].sort();
    const placeIds = [
      ...new Set(embeddingCandidates.map((candidate) => candidate.place.id)),
    ].sort();
    const osmVectors = await embedFn(osmIds.map((id) => osmById.get(id)?.source.name ?? ""));
    const placeVectors = await embedFn(
      placeIds.map((id) => {
        const place = placeById.get(id)?.source;
        return [place?.name, place?.address].filter(Boolean).join(" ");
      }),
    );
    const osmVectorById = new Map(osmIds.map((id, index) => [id, osmVectors[index]]));
    const placeVectorById = new Map(placeIds.map((id, index) => [id, placeVectors[index]]));
    for (const candidate of embeddingCandidates) {
      const osmVector = osmVectorById.get(candidate.osm.id);
      const placeVector = placeVectorById.get(candidate.place.id);
      if (!osmVector || !placeVector) continue;
      const cosine = cosineSimilarity(osmVector, placeVector);
      if (cosine <= cosineFloor) continue;
      const proximity = 1 - candidate.distanceM / thresholds.softWindowM;
      edges.push({
        a: candidate.osm,
        b: candidate.place,
        score: {
          method: "embedding",
          matchConfidence: Math.min(1, cosine * (0.95 + 0.05 * proximity)),
          distanceM: candidate.distanceM,
          nameSimilarity: nameSimilarity(candidate.osm.name, candidate.place.name),
          categoryCompatible: true,
          evidence: [`embedding-cosine:${cosine.toFixed(6)}`, "no-structured-conflict"],
        },
      });
    }
  }

  return assignConflationPairs(edges).map((edge) => {
    const osm = osmById.get(edge.a.id)?.source;
    const place = placeById.get(edge.b.id)?.source;
    if (!osm || !place) throw new Error("Assigned conflation edge lost its source record");
    return {
      osm_type: osm.osm_type,
      osm_id: osm.osm_id,
      gers_id: place.gersId,
      source_confidence: place.confidence ?? null,
      match_confidence: edge.score.matchConfidence,
      distance_m: edge.score.distanceM,
      method: edge.score.method,
      evidence: {
        nameSimilarity: edge.score.nameSimilarity,
        categoryCompatible: edge.score.categoryCompatible,
        signals: edge.score.evidence,
      },
      release,
    };
  });
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
  const { ollamaUrl, useEmbeddings = false, onProgress } = opts;
  const release = await resolveOvertureRelease(opts.release);
  const schema = opts.schema ?? "overture_places";

  const placesRows = await sql.unsafe<
    {
      gers_id: string;
      name: string;
      lat: number;
      lng: number;
      h3_r8: string | null;
      basic_category: string | null;
      taxonomy_primary: string | null;
      taxonomy_hierarchy: string[] | null;
      taxonomy_alternates: string[] | null;
      addresses: unknown;
      wikidata: string | null;
      phones: string[] | null;
      website: string | null;
      confidence: number | null;
    }[]
  >(
    `SELECT gers_id,
            name,
            ST_Y(geom) AS lat,
            ST_X(geom) AS lng,
            h3_r8,
            basic_category,
            taxonomy_primary,
            taxonomy_hierarchy,
            taxonomy_alternates,
            addresses,
            brand->>'wikidata' AS wikidata,
            phones,
            websites[1] AS website,
            confidence
     FROM "${schema}".places
     WHERE (operating_status IS NULL OR operating_status <> 'permanently_closed')
       AND (confidence IS NULL OR confidence >= ${MIN_CONFLATE_CONFIDENCE})`,
    [],
  );

  const places: OverturePlacePoint[] = placesRows.map((r) => {
    let freeform: string | undefined;
    let postcode: string | undefined;
    if (r.addresses && typeof r.addresses === "object") {
      const addrArr = r.addresses as Array<{ freeform?: string; postcode?: string }>;
      freeform = addrArr[0]?.freeform ?? undefined;
      postcode = addrArr[0]?.postcode ?? undefined;
    }
    return {
      gersId: r.gers_id,
      name: r.name,
      lat: Number(r.lat),
      lng: Number(r.lng),
      h3_r8: r.h3_r8,
      category: overtureTaxonomyToOpenMapX({
        basicCategory: r.basic_category,
        primary: r.taxonomy_primary,
        hierarchy: r.taxonomy_hierarchy,
        alternates: r.taxonomy_alternates,
      }),
      address: freeform,
      confidence: r.confidence ?? undefined,
      addressKey: overtureAddressKey(freeform, postcode) ?? undefined,
      wikidata: r.wikidata ?? undefined,
      phones: parsePhones(r.phones),
      website: websiteDomain(r.website) ?? undefined,
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
      street: string | null;
      housenumber: string | null;
      postcode: string | null;
      wikidata: string | null;
      phone: string | null;
      website: string | null;
    }[]
  >(
    `SELECT osm_type, osm_id, name, lat, lng, category,
            tags->>'addr:street' AS street,
            tags->>'addr:housenumber' AS housenumber,
            tags->>'addr:postcode' AS postcode,
            COALESCE(tags->>'wikidata', tags->>'brand:wikidata') AS wikidata,
            COALESCE(tags->>'phone', tags->>'contact:phone') AS phone,
            COALESCE(tags->>'website', tags->>'contact:website', tags->>'url') AS website
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
    addressKey: osmAddressKey(r.street, r.housenumber, r.postcode) ?? undefined,
    wikidata: r.wikidata ?? undefined,
    phones: parsePhones(r.phone),
    website: websiteDomain(r.website) ?? undefined,
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

  // Full rebuild: conflate recomputes the complete one-to-one link set.
  await sql.unsafe(`DELETE FROM "${schema}".poi_conflation_link`);

  if (links.length === 0) {
    return { linked: 0 };
  }

  const COLS = 9;
  const rowsPerBatch = Math.floor(65500 / COLS);

  for (let i = 0; i < links.length; i += rowsPerBatch) {
    const batch = links.slice(i, i + rowsPerBatch);

    const placeholders = batch
      .map(
        (_, k) =>
          `($${k * COLS + 1}, $${k * COLS + 2}::BIGINT, $${k * COLS + 3}, ` +
          `$${k * COLS + 4}::DOUBLE PRECISION, $${k * COLS + 5}::DOUBLE PRECISION, ` +
          `$${k * COLS + 6}::DOUBLE PRECISION, $${k * COLS + 7}, ` +
          `$${k * COLS + 8}::JSONB, $${k * COLS + 9})`,
      )
      .join(", ");

    const values = batch.flatMap((l) => [
      l.osm_type,
      l.osm_id,
      l.gers_id,
      l.source_confidence,
      l.match_confidence,
      l.distance_m,
      l.method,
      JSON.stringify(l.evidence),
      l.release,
    ]);

    await sql.unsafe(
      `INSERT INTO "${schema}".poi_conflation_link
         (osm_type, osm_id, gers_id, source_confidence, match_confidence,
          distance_m, method, evidence, release)
       VALUES ${placeholders}
       ON CONFLICT (osm_type, osm_id)
       DO UPDATE SET
         gers_id          = EXCLUDED.gers_id,
         source_confidence = EXCLUDED.source_confidence,
         match_confidence  = EXCLUDED.match_confidence,
         distance_m        = EXCLUDED.distance_m,
         method            = EXCLUDED.method,
         evidence          = EXCLUDED.evidence,
         release           = EXCLUDED.release`,
      values,
    );
  }

  onProgress?.(`Upserted ${links.length} conflation links into poi_conflation_link.`);
  return { linked: links.length };
}
