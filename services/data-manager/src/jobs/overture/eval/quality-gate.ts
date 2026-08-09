import {
  DEFAULT_CONFLATION_THRESHOLDS,
  fusePoiResults,
  type PoiSearchResult,
  rankAndLimitPoiResults,
} from "@openmapx/core";
import { openMapXCategoryToOvertureConcepts } from "@openmapx/core/utils/overtureCategoryMap";
import { sql } from "../../../db/index.js";
import { assertValidRegion } from "../pull.js";
import { assertValidOvertureSchema } from "../schema.js";
import { OVERTURE_QUALITY_BASELINE, type OvertureQualityCase } from "./quality-baseline.js";

export interface OvertureQualityCaseResult {
  caseId: string;
  resultCount: number;
  relevantRecall: number;
  knownIrrelevantHits: number;
  knownDuplicateHits: number;
  violations: string[];
}

export interface OvertureQualityGateResult {
  applicableCases: number;
  cases: OvertureQualityCaseResult[];
}

/**
 * Result window the baseline judgments were labeled against. Pinned rather than
 * inherited from the product display cap: the gate's thresholds (known
 * irrelevant and duplicate hits) count occurrences inside the window, so
 * widening it would move the measurements without any change in conflation
 * quality. Re-label the baselines before changing this.
 */
const QUALITY_GATE_RESULT_WINDOW = 50;

/** True when the imported Geofabrik region contains the labeled case. */
export function appliesToImportedRegion(importedRegion: string, caseRegion: string): boolean {
  assertValidRegion(importedRegion);
  assertValidRegion(caseRegion);
  return caseRegion === importedRegion || caseRegion.startsWith(`${importedRegion}/`);
}

export function evaluateOvertureQualityCase(
  baseline: OvertureQualityCase,
  resultIds: readonly string[],
  resultCount = resultIds.length,
): OvertureQualityCaseResult {
  const returned = new Set(resultIds);
  const relevant = baseline.judgments.filter((judgment) => judgment.relevant);
  const relevantHits = relevant.filter((judgment) => returned.has(judgment.gersId)).length;
  const relevantRecall = relevant.length === 0 ? 1 : relevantHits / relevant.length;
  const knownIrrelevantHits = baseline.judgments.filter(
    (judgment) => !judgment.relevant && returned.has(judgment.gersId),
  ).length;
  const knownDuplicateHits = baseline.judgments.filter(
    (judgment) => judgment.duplicateOf && returned.has(judgment.gersId),
  ).length;
  const violations: string[] = [];

  if (resultCount < baseline.minimumResultCount) {
    violations.push(`result count ${resultCount} < ${baseline.minimumResultCount}`);
  }
  if (relevantRecall < baseline.minimumRelevantRecall) {
    violations.push(
      `relevant recall ${relevantRecall.toFixed(3)} < ${baseline.minimumRelevantRecall.toFixed(3)}`,
    );
  }
  if (knownIrrelevantHits > baseline.maximumKnownIrrelevantHits) {
    violations.push(
      `known irrelevant hits ${knownIrrelevantHits} > ${baseline.maximumKnownIrrelevantHits}`,
    );
  }
  if (knownDuplicateHits > baseline.maximumKnownDuplicateHits) {
    violations.push(
      `known duplicate hits ${knownDuplicateHits} > ${baseline.maximumKnownDuplicateHits}`,
    );
  }

  return {
    caseId: baseline.id,
    resultCount,
    relevantRecall,
    knownIrrelevantHits,
    knownDuplicateHits,
    violations,
  };
}

interface FusedOsmRow {
  osm_type: string;
  osm_id: string;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
}

interface FusedOvertureRow {
  gers_id: string;
  name: string;
  lat: number;
  lng: number;
  phone: string | null;
  website: string | null;
  address: string | null;
}

/** Mirrors the final category-search union against the fully assigned next links. */
async function queryFusedCase(
  schema: string,
  baseline: OvertureQualityCase,
): Promise<PoiSearchResult[]> {
  const concepts = openMapXCategoryToOvertureConcepts(baseline.category);
  if (concepts.length === 0) {
    throw new Error(`Quality baseline ${baseline.id} uses unmapped category ${baseline.category}`);
  }
  const { west, south, east, north } = baseline.bbox;
  const [osmRows, overtureRows, linkRows] = await Promise.all([
    sql.unsafe<FusedOsmRow[]>(
      `SELECT osm_type, osm_id::TEXT, name, lat, lng, category,
              COALESCE(tags->>'phone', tags->>'contact:phone') AS phone,
              COALESCE(tags->>'website', tags->>'contact:website', tags->>'url') AS website,
              CONCAT_WS(' ', tags->>'addr:street', tags->>'addr:housenumber') AS address
       FROM "${schema}".osm_pois
       WHERE lng BETWEEN $1 AND $3 AND lat BETWEEN $2 AND $4 AND category = $5`,
      [west, south, east, north, baseline.category],
    ),
    sql.unsafe<FusedOvertureRow[]>(
      `SELECT gers_id, name, ST_Y(geom) AS lat, ST_X(geom) AS lng,
              phones[1] AS phone, websites[1] AS website,
              addresses->0->>'freeform' AS address
       FROM "${schema}".places
       WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
         AND (operating_status IS NULL OR operating_status <> 'permanently_closed')
         AND (confidence IS NULL OR confidence >= $6)
         AND (
           basic_category = ANY($5::TEXT[])
           OR taxonomy_primary = ANY($5::TEXT[])
           OR taxonomy_hierarchy && $5::TEXT[]
           OR taxonomy_alternates && $5::TEXT[]
         )
       ORDER BY geom <-> ST_SetSRID(ST_MakePoint(($1 + $3) / 2, ($2 + $4) / 2), 4326)
       LIMIT 200`,
      [west, south, east, north, concepts, 0.5],
    ),
    sql.unsafe<{ osm_type: string; osm_id: string; gers_id: string }[]>(
      `SELECT link.osm_type, link.osm_id::TEXT, link.gers_id
       FROM "${schema}".poi_conflation_link_next AS link
       JOIN "${schema}".osm_pois AS osm USING (osm_type, osm_id)
       WHERE osm.lng BETWEEN $1 AND $3 AND osm.lat BETWEEN $2 AND $4
         AND osm.category = $5`,
      [west, south, east, north, baseline.category],
    ),
  ]);

  const osm: PoiSearchResult[] = osmRows.map((row) => ({
    id: `osm:${row.osm_type}/${row.osm_id}`,
    name: row.name,
    coordinates: [Number(row.lng), Number(row.lat)],
    category: row.category ?? undefined,
    phone: row.phone ?? undefined,
    website: row.website ?? undefined,
    address: row.address || undefined,
  }));
  const overture: PoiSearchResult[] = overtureRows.map((row) => ({
    id: `overture:${row.gers_id}`,
    gersId: row.gers_id,
    name: row.name,
    coordinates: [Number(row.lng), Number(row.lat)],
    category: baseline.category,
    phone: row.phone ?? undefined,
    website: row.website ?? undefined,
    address: row.address ?? undefined,
  }));
  const links = new Map(
    linkRows.map((row) => [`${row.osm_type}/${row.osm_id}`, row.gers_id] as const),
  );
  return rankAndLimitPoiResults(
    fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS, links),
    { west, south, east, north },
    QUALITY_GATE_RESULT_WINDOW,
  );
}

async function queryCase(schema: string, baseline: OvertureQualityCase): Promise<string[]> {
  const concepts = openMapXCategoryToOvertureConcepts(baseline.category);
  if (concepts.length === 0) {
    throw new Error(`Quality baseline ${baseline.id} uses unmapped category ${baseline.category}`);
  }
  const { west, south, east, north } = baseline.bbox;
  const rows = await sql.unsafe<{ gers_id: string }[]>(
    `SELECT gers_id
     FROM "${schema}".places
     WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
       AND (operating_status IS NULL OR operating_status <> 'permanently_closed')
       AND (confidence IS NULL OR confidence >= $6)
       AND (
         basic_category = ANY($5::TEXT[])
         OR taxonomy_primary = ANY($5::TEXT[])
         OR taxonomy_hierarchy && $5::TEXT[]
         OR taxonomy_alternates && $5::TEXT[]
       )
     ORDER BY
       geom <-> ST_SetSRID(ST_MakePoint(($1 + $3) / 2, ($2 + $4) / 2), 4326),
       confidence DESC NULLS LAST,
       ((addresses IS NOT NULL)::INT + (websites IS NOT NULL)::INT +
        (phones IS NOT NULL)::INT + (emails IS NOT NULL)::INT) DESC,
       gers_id
     LIMIT 50`,
    [west, south, east, north, concepts, 0.5],
  );
  return rows.map((row) => row.gers_id);
}

/**
 * Executes every labeled case contained by the imported region against the
 * staging schema. Any regression fails before the atomic activation swap.
 */
export async function validateOvertureQuality(
  schema: string,
  region: string,
  cases: readonly OvertureQualityCase[] = OVERTURE_QUALITY_BASELINE,
): Promise<OvertureQualityGateResult> {
  assertValidOvertureSchema(schema);
  assertValidRegion(region);
  const applicable = cases.filter((entry) => appliesToImportedRegion(region, entry.region));
  const results: OvertureQualityCaseResult[] = [];
  for (const entry of applicable) {
    results.push(evaluateOvertureQualityCase(entry, await queryCase(schema, entry)));
  }

  const failures = results.filter((result) => result.violations.length > 0);
  if (failures.length > 0) {
    throw new Error(
      `Overture staged-release quality regression: ${failures
        .map((result) => `${result.caseId}: ${result.violations.join(", ")}`)
        .join("; ")}`,
    );
  }
  return { applicableCases: applicable.length, cases: results };
}

/**
 * Validates the same OSM-authoritative, Overture-augmenting response shape that
 * production publishes. This runs after exact assignment and before the atomic
 * link-table activation.
 */
export async function validateFusedOvertureQuality(
  schema: string,
  region: string,
  cases: readonly OvertureQualityCase[] = OVERTURE_QUALITY_BASELINE,
): Promise<OvertureQualityGateResult> {
  assertValidOvertureSchema(schema);
  assertValidRegion(region);
  const applicable = cases.filter((entry) => appliesToImportedRegion(region, entry.region));
  const results: OvertureQualityCaseResult[] = [];
  for (const entry of applicable) {
    const fused = await queryFusedCase(schema, entry);
    results.push(
      evaluateOvertureQualityCase(
        entry,
        fused.flatMap((result) => (result.gersId ? [result.gersId] : [])),
        fused.length,
      ),
    );
  }
  const failures = results.filter((result) => result.violations.length > 0);
  if (failures.length > 0) {
    throw new Error(
      `Overture fused-search quality regression: ${failures
        .map((result) => `${result.caseId}: ${result.violations.join(", ")}`)
        .join("; ")}`,
    );
  }
  return { applicableCases: applicable.length, cases: results };
}
