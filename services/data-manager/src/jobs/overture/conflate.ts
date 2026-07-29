import {
  haversineMeters,
  nameSimilarity,
  osmAddressKey,
  overtureAddressKey,
  parsePhones,
  websiteDomain,
} from "@openmapx/core/utils/geo-server";
import { overtureTaxonomyToOpenMapX } from "@openmapx/core/utils/overtureCategoryMap";
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
import { assertValidOvertureSchema } from "./schema.js";

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
  const edges = await scoreLinkCandidates(places, osmPois, opts);
  return assignLinkRecords(edges);
}

/**
 * Scores every accepted edge in one already-bounded H3 candidate batch.
 * Assignment is deliberately separate: production persists these edges across
 * batches before solving the region-wide one-to-one graph.
 */
export async function scoreLinkCandidates(
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

  return edges.map((edge) => {
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

/** Applies the exact cardinality-first global assignment to scored links. */
export function assignLinkRecords(edges: LinkRecord[]): LinkRecord[] {
  const byPair = new Map<string, LinkRecord>();
  const scored: ScoredConflationPair[] = edges.map((edge) => {
    const osmId = `${edge.osm_type}:${edge.osm_id}`;
    byPair.set(`${osmId}\u0000${edge.gers_id}`, edge);
    return {
      a: { id: osmId, name: "", lat: 0, lng: 0 },
      b: { id: edge.gers_id, name: "", lat: 0, lng: 0 },
      score: {
        method: edge.method,
        matchConfidence: edge.match_confidence,
        distanceM: edge.distance_m,
        nameSimilarity: edge.evidence.nameSimilarity,
        categoryCompatible: edge.evidence.categoryCompatible,
        evidence: edge.evidence.signals,
      },
    };
  });
  return assignConflationPairs(scored).map((edge) => {
    const link = byPair.get(`${edge.a.id}\u0000${edge.b.id}`);
    if (!link) throw new Error("Assigned conflation edge lost its persisted candidate");
    return link;
  });
}

const OSM_PAGE_SIZE = 2_000;
const ENDPOINT_PAGE_SIZE = 25_000;
const COMPONENT_BATCH_SIZE = 2_000;
const LINK_COLUMN_COUNT = 9;
const LINK_ROWS_PER_BATCH = Math.floor(65_500 / LINK_COLUMN_COUNT);

interface PlaceRow {
  gers_id: string;
  name: string;
  lat: number;
  lng: number;
  h3_r8: string;
  basic_category: string | null;
  taxonomy_primary: string | null;
  taxonomy_hierarchy: string[] | null;
  taxonomy_alternates: string[] | null;
  addresses: unknown;
  wikidata: string | null;
  phones: string[] | null;
  website: string | null;
  confidence: number | null;
}

interface OsmRow {
  osm_type: string;
  osm_id: string;
  name: string;
  lat: number;
  lng: number;
  h3_r8: string;
  category: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  wikidata: string | null;
  phone: string | null;
  website: string | null;
}

function placeRowToPoint(row: PlaceRow): OverturePlacePoint {
  let freeform: string | undefined;
  let postcode: string | undefined;
  if (row.addresses && typeof row.addresses === "object") {
    const addresses = row.addresses as Array<{ freeform?: string; postcode?: string }>;
    freeform = addresses[0]?.freeform;
    postcode = addresses[0]?.postcode;
  }
  return {
    gersId: row.gers_id,
    name: row.name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    h3_r8: row.h3_r8,
    category: overtureTaxonomyToOpenMapX({
      basicCategory: row.basic_category,
      primary: row.taxonomy_primary,
      hierarchy: row.taxonomy_hierarchy,
      alternates: row.taxonomy_alternates,
    }),
    address: freeform,
    confidence: row.confidence ?? undefined,
    addressKey: overtureAddressKey(freeform, postcode) ?? undefined,
    wikidata: row.wikidata ?? undefined,
    phones: parsePhones(row.phones),
    website: websiteDomain(row.website) ?? undefined,
  };
}

function osmRowToPoint(row: OsmRow): OsmPoiPoint {
  return {
    osm_type: row.osm_type,
    osm_id: Number(row.osm_id),
    name: row.name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    h3_r8: row.h3_r8,
    category: row.category ?? undefined,
    addressKey: osmAddressKey(row.street, row.housenumber, row.postcode) ?? undefined,
    wikidata: row.wikidata ?? undefined,
    phones: parsePhones(row.phone),
    website: websiteDomain(row.website) ?? undefined,
  };
}

async function insertLinkRows(
  schema: string,
  table: "poi_conflation_candidate" | "poi_conflation_link" | "poi_conflation_link_next",
  links: LinkRecord[],
  execute: (query: string, parameters: (string | number | null)[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < links.length; i += LINK_ROWS_PER_BATCH) {
    const batch = links.slice(i, i + LINK_ROWS_PER_BATCH);
    const placeholders = batch
      .map(
        (_, k) =>
          `($${k * LINK_COLUMN_COUNT + 1}, $${k * LINK_COLUMN_COUNT + 2}::BIGINT, ` +
          `$${k * LINK_COLUMN_COUNT + 3}, $${k * LINK_COLUMN_COUNT + 4}::DOUBLE PRECISION, ` +
          `$${k * LINK_COLUMN_COUNT + 5}::DOUBLE PRECISION, ` +
          `$${k * LINK_COLUMN_COUNT + 6}::DOUBLE PRECISION, $${k * LINK_COLUMN_COUNT + 7}, ` +
          `$${k * LINK_COLUMN_COUNT + 8}::JSONB, $${k * LINK_COLUMN_COUNT + 9})`,
      )
      .join(", ");
    const values: (string | number | null)[] = batch.flatMap((link) => [
      link.osm_type,
      link.osm_id,
      link.gers_id,
      link.source_confidence,
      link.match_confidence,
      link.distance_m,
      link.method,
      JSON.stringify(link.evidence),
      link.release,
    ]);
    await execute(
      `INSERT INTO "${schema}".${table}
           (osm_type, osm_id, gers_id, source_confidence, match_confidence,
            distance_m, method, evidence, release)
         VALUES ${placeholders}
         ON CONFLICT DO NOTHING`,
      values,
    );
  }
}

export interface ConflationScoreCursor {
  h3: string | null;
  osmType: string;
  osmId: string;
}

export interface ScoreOvertureCandidatesResult {
  candidates: number;
  processed: number;
  cursor: ConflationScoreCursor;
}

/**
 * Scores a release in bounded keyset pages. The caller owns the durable cursor
 * and decides whether this is a fresh score or a continuation. Each accepted
 * edge has a stable primary key, so replaying the page immediately before a
 * crash is harmless.
 */
export async function scoreOvertureCandidates(opts: {
  region: string;
  release?: string;
  ollamaUrl?: string;
  useEmbeddings?: boolean;
  schema?: string;
  resume?: {
    cursor: ConflationScoreCursor;
    processed: number;
    candidates: number;
  };
  onProgress?: (msg: string) => void;
  onCheckpoint?: (
    processed: number,
    candidates: number,
    cursor: ConflationScoreCursor,
  ) => Promise<void>;
}): Promise<ScoreOvertureCandidatesResult> {
  assertValidRegion(opts.region);
  const { ollamaUrl, useEmbeddings = false, onProgress } = opts;
  const release = await resolveOvertureRelease(opts.release);
  const schema = opts.schema ?? "overture_places";
  assertValidOvertureSchema(schema);

  if (useEmbeddings && ollamaUrl) {
    await ensureEmbeddingModel(DEFAULT_MODEL, ollamaUrl);
  }

  const embedFn = useEmbeddings ? (texts: string[]) => embed(texts, { ollamaUrl }) : undefined;
  if (!opts.resume) {
    await sql.unsafe(`TRUNCATE TABLE "${schema}".poi_conflation_candidate`);
  }

  let cursorCell = opts.resume?.cursor.h3 ?? null;
  let cursorType = opts.resume?.cursor.osmType ?? "";
  let cursorId = opts.resume?.cursor.osmId ?? "0";
  let processed = opts.resume?.processed ?? 0;
  let candidateCount = opts.resume?.candidates ?? 0;
  while (true) {
    const osmRows: OsmRow[] = await sql.unsafe<OsmRow[]>(
      `SELECT osm_type, osm_id, name, lat, lng, h3_r8, category,
              tags->>'addr:street' AS street,
              tags->>'addr:housenumber' AS housenumber,
              tags->>'addr:postcode' AS postcode,
              COALESCE(tags->>'wikidata', tags->>'brand:wikidata') AS wikidata,
              COALESCE(tags->>'phone', tags->>'contact:phone') AS phone,
              COALESCE(tags->>'website', tags->>'contact:website', tags->>'url') AS website
       FROM "${schema}".osm_pois
       WHERE ($1::TEXT IS NULL
          OR h3_r8 > $1
          OR (h3_r8 = $1 AND osm_type > $2)
          OR (h3_r8 = $1 AND osm_type = $2 AND osm_id > $3::BIGINT))
       ORDER BY h3_r8, osm_type, osm_id
       LIMIT $4`,
      [cursorCell, cursorType, cursorId, OSM_PAGE_SIZE],
    );
    if (osmRows.length === 0) break;

    const osmPois: OsmPoiPoint[] = osmRows.map(osmRowToPoint);
    const cells: string[] = [...new Set(osmPois.flatMap((poi) => gridDisk(ensureH3(poi), 1)))];
    const placeRows: PlaceRow[] = await sql.unsafe<PlaceRow[]>(
      `SELECT gers_id, name, ST_Y(geom) AS lat, ST_X(geom) AS lng, h3_r8,
              basic_category, taxonomy_primary, taxonomy_hierarchy, taxonomy_alternates,
              addresses, brand->>'wikidata' AS wikidata, phones, websites[1] AS website,
              confidence
       FROM "${schema}".places
       WHERE h3_r8 = ANY($1::TEXT[])
         AND (operating_status IS NULL OR operating_status <> 'permanently_closed')
         AND (confidence IS NULL OR confidence >= ${MIN_CONFLATE_CONFIDENCE})`,
      [cells],
    );
    const candidates = await scoreLinkCandidates(placeRows.map(placeRowToPoint), osmPois, {
      thresholds: DEFAULT_CONFLATION_THRESHOLDS,
      embedFn,
      release,
    });
    await insertLinkRows(schema, "poi_conflation_candidate", candidates, (query, parameters) =>
      sql.unsafe(query, parameters),
    );
    processed += osmRows.length;
    candidateCount += candidates.length;
    const last: OsmRow | undefined = osmRows[osmRows.length - 1];
    if (!last) break;
    cursorCell = last.h3_r8;
    cursorType = last.osm_type;
    cursorId = last.osm_id;
    await opts.onCheckpoint?.(processed, candidateCount, {
      h3: cursorCell,
      osmType: cursorType,
      osmId: cursorId,
    });
    onProgress?.(
      `Scored ${processed} OSM POIs in bounded pages (${candidateCount} accepted edges)...`,
    );
  }

  await sql.unsafe(`ANALYZE "${schema}".poi_conflation_candidate`);
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `SELECT COUNT(*)::TEXT AS count FROM "${schema}".poi_conflation_candidate`,
    [],
  );
  candidateCount = Number(count ?? 0);
  return {
    candidates: candidateCount,
    processed,
    cursor: { h3: cursorCell, osmType: cursorType, osmId: cursorId },
  };
}

class DisjointSet {
  private readonly index = new Map<string, number>();
  private readonly keys: string[] = [];
  private readonly parent: number[] = [];
  private readonly rank: number[] = [];

  private add(key: string): number {
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;
    const next = this.parent.length;
    this.index.set(key, next);
    this.keys.push(key);
    this.parent.push(next);
    this.rank.push(0);
    return next;
  }

  private findIndex(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    let cursor = index;
    while (this.parent[cursor] !== cursor) {
      const next = this.parent[cursor];
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(left: string, right: string): void {
    let a = this.findIndex(this.add(left));
    let b = this.findIndex(this.add(right));
    if (a === b) return;
    if (this.rank[a] < this.rank[b]) [a, b] = [b, a];
    this.parent[b] = a;
    if (this.rank[a] === this.rank[b]) this.rank[a] += 1;
  }

  rootOf(key: string): number {
    const index = this.index.get(key);
    if (index === undefined) throw new Error(`Unknown conflation endpoint ${key}`);
    return this.findIndex(index);
  }

  osmKeys(): string[] {
    return this.keys.filter((key) => key.startsWith("o:"));
  }
}

interface EndpointRow {
  osm_type: string;
  osm_id: string;
  gers_id: string;
}

async function insertComponentRows(
  schema: string,
  rows: Array<{ osmType: string; osmId: string; componentId: number }>,
): Promise<void> {
  const batchSize = 10_000;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    await sql.unsafe(
      `INSERT INTO "${schema}".poi_conflation_component
         (osm_type, osm_id, component_id)
       SELECT UNNEST($1::TEXT[]), UNNEST($2::BIGINT[]), UNNEST($3::BIGINT[])`,
      [
        batch.map((row) => row.osmType),
        batch.map((row) => row.osmId),
        batch.map((row) => row.componentId),
      ],
    );
  }
}

/**
 * Builds exact connected-component labels from the persisted bipartite graph.
 * Only endpoint identifiers are held during this pass; the much wider scored
 * rows remain in Postgres and are read later one bounded group of components at
 * a time.
 */
export async function buildConflationComponents(
  schema: string,
  onProgress?: (msg: string) => void,
): Promise<number> {
  assertValidOvertureSchema(schema);
  await sql.unsafe(
    `TRUNCATE TABLE "${schema}".poi_conflation_component,
                    "${schema}".poi_conflation_link_next`,
  );

  const sets = new DisjointSet();
  let cursorType = "";
  let cursorId = "0";
  let cursorGers = "";
  let edges = 0;
  while (true) {
    const rows = await sql.unsafe<EndpointRow[]>(
      `SELECT osm_type, osm_id::TEXT, gers_id
       FROM "${schema}".poi_conflation_candidate
       WHERE osm_type > $1
          OR (osm_type = $1 AND osm_id > $2::BIGINT)
          OR (osm_type = $1 AND osm_id = $2::BIGINT AND gers_id > $3)
       ORDER BY osm_type, osm_id, gers_id
       LIMIT $4`,
      [cursorType, cursorId, cursorGers, ENDPOINT_PAGE_SIZE],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      sets.union(`o:${row.osm_type}:${row.osm_id}`, `g:${row.gers_id}`);
    }
    edges += rows.length;
    const last = rows[rows.length - 1];
    if (!last) break;
    cursorType = last.osm_type;
    cursorId = last.osm_id;
    cursorGers = last.gers_id;
    onProgress?.(`Indexed ${edges} candidate edges into exact connected components...`);
  }

  const osmKeys = sets.osmKeys().sort();
  const componentByRoot = new Map<number, number>();
  const rows: Array<{ osmType: string; osmId: string; componentId: number }> = [];
  for (const key of osmKeys) {
    const root = sets.rootOf(key);
    let componentId = componentByRoot.get(root);
    if (componentId === undefined) {
      componentId = componentByRoot.size + 1;
      componentByRoot.set(root, componentId);
    }
    const [, osmType, osmId] = key.split(":");
    if (!osmType || !osmId) throw new Error(`Invalid OSM component endpoint ${key}`);
    rows.push({ osmType, osmId, componentId });
  }
  await insertComponentRows(schema, rows);
  await sql.unsafe(`ANALYZE "${schema}".poi_conflation_component`);
  onProgress?.(`Materialized ${componentByRoot.size} disconnected components from ${edges} edges.`);
  return componentByRoot.size;
}

interface ComponentLinkRow extends LinkRecord {
  component_id: string;
}

export interface AssignOvertureCandidatesResult {
  components: number;
  assignmentCursor: number;
  stagedLinks: number;
}

/** Solves exact one-to-one assignments independently per graph component. */
export async function assignOvertureCandidates(opts: {
  schema?: string;
  componentCount?: number | null;
  assignmentCursor?: number | null;
  stagedLinks?: number | null;
  onProgress?: (msg: string) => void;
  onWorkspace?: (components: number) => Promise<void>;
  onCheckpoint?: (assignmentCursor: number, stagedLinks: number) => Promise<void>;
}): Promise<AssignOvertureCandidatesResult> {
  const schema = opts.schema ?? "overture_places";
  assertValidOvertureSchema(schema);
  let components = opts.componentCount ?? null;
  let assignmentCursor = opts.assignmentCursor ?? 0;
  let stagedLinks = opts.stagedLinks ?? 0;

  const [{ mappings }] = await sql.unsafe<{ mappings: string }[]>(
    `SELECT COUNT(*)::TEXT AS mappings FROM "${schema}".poi_conflation_component`,
    [],
  );
  if (components === null || (components > 0 && Number(mappings ?? 0) === 0)) {
    components = await buildConflationComponents(schema, opts.onProgress);
    assignmentCursor = 0;
    stagedLinks = 0;
    await opts.onWorkspace?.(components);
  }

  while (true) {
    const rows = await sql.unsafe<ComponentLinkRow[]>(
      `WITH next_components AS MATERIALIZED (
         SELECT DISTINCT component_id
         FROM "${schema}".poi_conflation_component
         WHERE component_id > $1
         ORDER BY component_id
         LIMIT $2
       )
       SELECT component.component_id::TEXT, candidate.osm_type,
              candidate.osm_id, candidate.gers_id, candidate.source_confidence,
              candidate.match_confidence, candidate.distance_m, candidate.method,
              candidate.evidence, candidate.release
       FROM next_components
       JOIN "${schema}".poi_conflation_component AS component USING (component_id)
       JOIN "${schema}".poi_conflation_candidate AS candidate
         USING (osm_type, osm_id)
       ORDER BY component.component_id, candidate.osm_type,
                candidate.osm_id, candidate.gers_id`,
      [assignmentCursor, COMPONENT_BATCH_SIZE],
    );
    if (rows.length === 0) break;

    const byComponent = new Map<number, LinkRecord[]>();
    for (const row of rows) {
      const componentId = Number(row.component_id);
      const links = byComponent.get(componentId) ?? [];
      links.push({
        osm_type: row.osm_type,
        osm_id: Number(row.osm_id),
        gers_id: row.gers_id,
        source_confidence: row.source_confidence === null ? null : Number(row.source_confidence),
        match_confidence: Number(row.match_confidence),
        distance_m: Number(row.distance_m),
        method: row.method,
        evidence: row.evidence,
        release: row.release,
      });
      byComponent.set(componentId, links);
    }
    const selected = [...byComponent.values()].flatMap(assignLinkRecords);
    await insertLinkRows(schema, "poi_conflation_link_next", selected, (query, parameters) =>
      sql.unsafe(query, parameters),
    );
    assignmentCursor = Math.max(...byComponent.keys());
    stagedLinks += selected.length;
    await opts.onCheckpoint?.(assignmentCursor, stagedLinks);
    opts.onProgress?.(
      `Assigned ${assignmentCursor}/${components} exact components ` +
        `(${stagedLinks} staged links)...`,
    );
  }

  const [{ linked }] = await sql.unsafe<{ linked: string }[]>(
    `SELECT COUNT(*)::TEXT AS linked FROM "${schema}".poi_conflation_link_next`,
    [],
  );
  return { components, assignmentCursor, stagedLinks: Number(linked ?? 0) };
}

/** Atomically publishes the completely assigned next-link snapshot. */
export async function publishOvertureLinks(
  schema = "overture_places",
): Promise<{ linked: number }> {
  assertValidOvertureSchema(schema);

  await sql.begin(async (tx) => {
    await tx.unsafe(`DELETE FROM "${schema}".poi_conflation_link`);
    await tx.unsafe(
      `INSERT INTO "${schema}".poi_conflation_link
         (osm_type, osm_id, gers_id, source_confidence, match_confidence,
          distance_m, method, evidence, release)
       SELECT osm_type, osm_id, gers_id, source_confidence, match_confidence,
              distance_m, method, evidence, release
       FROM "${schema}".poi_conflation_link_next`,
    );
  });

  const [{ linked }] = await sql.unsafe<{ linked: string }[]>(
    `SELECT COUNT(*)::TEXT AS linked FROM "${schema}".poi_conflation_link`,
    [],
  );
  const linkedCount = Number(linked ?? 0);
  return { linked: linkedCount };
}

/** Clears retry artifacts only after state has durably reached `completed`. */
export async function cleanupOvertureConflationWorkspace(
  schema = "overture_places",
): Promise<void> {
  assertValidOvertureSchema(schema);
  await sql.unsafe(
    `TRUNCATE TABLE "${schema}".poi_conflation_candidate,
                    "${schema}".poi_conflation_component,
                    "${schema}".poi_conflation_link_next`,
  );
}
