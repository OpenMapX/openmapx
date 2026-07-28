/**
 * Overture ↔ OSM conflation evaluation harness.
 *
 * Without --labeled: loads OSM POIs and Overture places from the DB, generates
 * candidate pairs via generateCandidatePairs, writes candidates.tsv, then exits.
 * This TSV is the input for human labeling.
 *
 * With --labeled <file>: runs the threshold sweep using the real conflate()
 * function from packages/core. For each SWEEP_GRID cell, Overture places are
 * pre-filtered by confidenceFloor and operating_status before being passed to
 * conflate(). Precision/recall/F1 are computed against the labeled pairs.
 *
 * Usage:
 *   node --import tsx/esm src/jobs/overture/eval/run.ts \
 *     [--labeled path/to/labeled.tsv] \
 *     [--output path/to/results.json]
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  osmAddressKey,
  overtureAddressKey,
  parsePhones,
  websiteDomain,
} from "@openmapx/core/utils/geo-server";
import {
  type ConflationPoint,
  type ConflationThresholds,
  conflate,
} from "@openmapx/core/utils/poiConflation";
import { sql } from "../../../db/index.js";
import { generateCandidatePairs, type OsmPoi, type OverturePlace } from "./candidates.js";
import { computeMetrics, type MetricsResult, SWEEP_GRID, type SweepCell } from "./metrics.js";

interface OvertureRow {
  gers_id: string;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  address: string | null;
  postcode: string | null;
  wikidata: string | null;
  phones: string[] | null;
  website: string | null;
  confidence: number | null;
  operating_status: string | null;
}

interface OsmPoiRow {
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
}

interface LabeledEntry {
  osmType: string;
  osmId: string;
  gersId: string;
  isMatch: boolean;
}

interface SweepResult {
  cell: SweepCell;
  metrics: MetricsResult;
}

async function loadOverturePlaces(): Promise<OvertureRow[]> {
  return sql<OvertureRow[]>`
    SELECT
      gers_id,
      name,
      ST_Y(geom) AS lat,
      ST_X(geom) AS lng,
      basic_category AS category,
      addresses->0->>'freeform' AS address,
      addresses->0->>'postcode' AS postcode,
      brand->>'wikidata' AS wikidata,
      phones,
      websites[1] AS website,
      confidence,
      operating_status
    FROM overture_places.places
  `;
}

async function loadOsmPois(): Promise<OsmPoiRow[]> {
  return sql<OsmPoiRow[]>`
    SELECT osm_type, osm_id::TEXT AS osm_id, name, lat, lng, category,
      tags->>'addr:street' AS street,
      tags->>'addr:housenumber' AS housenumber,
      tags->>'addr:postcode' AS postcode,
      COALESCE(tags->>'wikidata', tags->>'brand:wikidata') AS wikidata,
      COALESCE(tags->>'phone', tags->>'contact:phone') AS phone,
      COALESCE(tags->>'website', tags->>'contact:website', tags->>'url') AS website
    FROM overture_places.osm_pois
  `;
}

function parseLabeledTsv(content: string): LabeledEntry[] {
  const lines = content.trim().split("\n");
  if (lines.length === 0) return [];
  const header = (lines[0] ?? "").split("\t");
  const idxOsmId = header.indexOf("osmId");
  const idxGersId = header.indexOf("gersId");
  const idxIsMatch = header.indexOf("isMatch");
  if (idxOsmId < 0 || idxGersId < 0 || idxIsMatch < 0) {
    throw new Error(
      "labeled TSV must have osmId, gersId, and isMatch columns — regenerate candidates.tsv first",
    );
  }
  const entries: LabeledEntry[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const osmId = cols[idxOsmId] ?? "";
    const gersId = cols[idxGersId] ?? "";
    const isMatchStr = cols[idxIsMatch] ?? "";
    if (!osmId || !gersId) continue;
    const osmType = osmId.includes("/") ? (osmId.split("/")[0] ?? "node") : "node";
    const bareOsmId = osmId.includes("/") ? (osmId.split("/")[1] ?? osmId) : osmId;
    const isMatch = isMatchStr.trim().toLowerCase() === "true";
    entries.push({ osmType, osmId: bareOsmId, gersId, isMatch });
  }
  return entries;
}

function runSweepWithConflate(
  osmRows: OsmPoiRow[],
  overtureRows: OvertureRow[],
  labeled: LabeledEntry[],
): SweepResult[] {
  return SWEEP_GRID.map((cell) => {
    const filteredOverture = overtureRows.filter(
      (r) =>
        (r.confidence ?? 1) >= cell.confidenceFloor && r.operating_status !== "permanently_closed",
    );

    // Mirror the production conflateOverture point construction so the sweep
    // measures the predicate that actually ships (address/wikidata/phone/website
    // corroboration), not a name-only subset of it.
    const osmPts: ConflationPoint[] = osmRows.map((r) => ({
      id: `${r.osm_type}/${r.osm_id}`,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      category: r.category ?? undefined,
      addressKey: osmAddressKey(r.street, r.housenumber, r.postcode) ?? undefined,
      wikidata: r.wikidata ?? undefined,
      phones: parsePhones(r.phone),
      website: websiteDomain(r.website) ?? undefined,
    }));

    const overturePts: ConflationPoint[] = filteredOverture.map((r) => ({
      id: r.gers_id,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      category: r.category ?? undefined,
      addressKey: overtureAddressKey(r.address, r.postcode) ?? undefined,
      wikidata: r.wikidata ?? undefined,
      phones: parsePhones(r.phones),
      website: websiteDomain(r.website) ?? undefined,
    }));

    const thresholds: ConflationThresholds = {
      alwaysMergeM: cell.alwaysMergeM,
      softWindowM: cell.softWindowM,
      nameDiceFloor: cell.nameDiceFloor,
    };

    const result = conflate(osmPts, overturePts, thresholds);

    const matchedPairs = new Set(result.matched.map((m) => `${m.a.id}|${m.b.id}`));

    const predictions = labeled.map((entry) => {
      const osmKey = `${entry.osmType}/${entry.osmId}`;
      const pairKey = `${osmKey}|${entry.gersId}`;
      return matchedPairs.has(pairKey);
    });
    const labels = labeled.map((entry) => entry.isMatch);

    const metrics = computeMetrics(labels, predictions);
    return { cell, metrics };
  });
}

function formatTable(results: SweepResult[]): string {
  const sorted = [...results].sort((a, b) => b.metrics.f1 - a.metrics.f1);
  const header = "rank  f1      prec    recall  tp  fp  fn  alwaysM  softM  diceFloor  confFloor";
  const rows = sorted.slice(0, 20).map((r, i) => {
    const m = r.metrics;
    const c = r.cell;
    return [
      String(i + 1).padStart(4),
      m.f1.toFixed(4).padStart(7),
      m.precision.toFixed(4).padStart(7),
      m.recall.toFixed(4).padStart(7),
      String(m.tp).padStart(4),
      String(m.fp).padStart(4),
      String(m.fn).padStart(4),
      String(c.alwaysMergeM).padStart(8),
      String(c.softWindowM).padStart(6),
      c.nameDiceFloor.toFixed(2).padStart(10),
      c.confidenceFloor.toFixed(1).padStart(10),
    ].join("  ");
  });
  return [header, ...rows].join("\n");
}

function findBestCell(results: SweepResult[]): SweepResult | undefined {
  return [...results]
    .filter((r) => r.metrics.precision >= 0.95)
    .sort((a, b) => b.metrics.f1 - a.metrics.f1)[0];
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    labeled: { type: "string" },
    output: { type: "string" },
  },
});

(async () => {
  if (!values.labeled) {
    console.log("No --labeled file provided — generating candidates.tsv for human labeling...");

    const [overtureRows, osmRows] = await Promise.all([loadOverturePlaces(), loadOsmPois()]);
    console.log(
      `Loaded ${osmRows.length} OSM POIs and ${overtureRows.length} Overture places from DB.`,
    );

    const osmPois: OsmPoi[] = osmRows.map((r) => ({
      osmType: r.osm_type as "node" | "way" | "relation",
      osmId: r.osm_id,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      category: r.category ?? undefined,
    }));

    const overturePlaces: OverturePlace[] = overtureRows.map((r) => ({
      gersId: r.gers_id,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      category: r.category ?? undefined,
      address: r.address ?? undefined,
    }));

    const pairs = generateCandidatePairs(osmPois, overturePlaces, { targetPairs: 300 });
    console.log(`Generated ${pairs.length} candidate pairs.`);

    const tsvHeader =
      "osmName\tovertureName\tdistance_m\tosmId\tgersId\tosm_category\toverture_addr\tisMatch";
    const tsvRows = pairs.map((p) =>
      [
        p.osmPoi.name,
        p.overturePlace.name,
        p.distanceM.toFixed(1),
        `${p.osmPoi.osmType}/${p.osmPoi.osmId}`,
        p.overturePlace.gersId,
        p.osmPoi.category ?? "",
        p.overturePlace.address ?? "",
        "",
      ].join("\t"),
    );

    const tsv = [tsvHeader, ...tsvRows].join("\n");
    const outPath = values.output ?? "candidates.tsv";
    writeFileSync(outPath, tsv, "utf8");
    console.log(`Wrote ${pairs.length} candidate pairs to ${outPath}`);
    console.log("Label the 'isMatch' column (true/false) and rerun with --labeled <file>.");
    await sql.end();
    return;
  }

  const { readFileSync } = await import("node:fs");
  const labeledContent = readFileSync(values.labeled, "utf8");
  const labeled = parseLabeledTsv(labeledContent);
  console.log(`Loaded ${labeled.length} labeled entries from ${values.labeled}.`);

  const [overtureRows, osmRows] = await Promise.all([loadOverturePlaces(), loadOsmPois()]);
  console.log(
    `Loaded ${osmRows.length} OSM POIs and ${overtureRows.length} Overture places from DB.`,
  );

  const results = runSweepWithConflate(osmRows, overtureRows, labeled);

  console.log("\nTop-20 threshold configurations by F1:\n");
  console.log(formatTable(results));

  const best = findBestCell(results);
  if (best) {
    const c = best.cell;
    const m = best.metrics;
    console.log(
      `\nBest cell at precision ≥ 0.95: alwaysMergeM=${c.alwaysMergeM} softWindowM=${c.softWindowM} ` +
        `nameDiceFloor=${c.nameDiceFloor} (confidenceFloor=${c.confidenceFloor} is a pre-filter only) ` +
        `→ precision=${m.precision.toFixed(4)} recall=${m.recall.toFixed(4)} f1=${m.f1.toFixed(4)}`,
    );
  } else {
    console.log("\nNo cell reached precision ≥ 0.95. Inspect the full table above.");
  }

  if (values.output) {
    writeFileSync(values.output, JSON.stringify(results, null, 2));
    console.log(`\nFull results written to ${values.output}`);
  }

  await sql.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
