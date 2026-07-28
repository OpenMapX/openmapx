import { openMapXCategoryToOvertureConcepts } from "@openmapx/core";
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

/** True when the imported Geofabrik region contains the labeled case. */
export function appliesToImportedRegion(importedRegion: string, caseRegion: string): boolean {
  assertValidRegion(importedRegion);
  assertValidRegion(caseRegion);
  return caseRegion === importedRegion || caseRegion.startsWith(`${importedRegion}/`);
}

export function evaluateOvertureQualityCase(
  baseline: OvertureQualityCase,
  resultIds: readonly string[],
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

  if (resultIds.length < baseline.minimumResultCount) {
    violations.push(`result count ${resultIds.length} < ${baseline.minimumResultCount}`);
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
    resultCount: resultIds.length,
    relevantRecall,
    knownIrrelevantHits,
    knownDuplicateHits,
    violations,
  };
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
