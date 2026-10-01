import { randomUUID } from "node:crypto";
import { normalizeSearchTerm } from "@openmapx/core";
import type postgres from "postgres";
import { scrubSecrets } from "../../utils/scrub-secrets.js";
import {
  createNotablePlacesOperationLock,
  type SearchIndexOperationLock,
} from "../search-index/operation-lock.js";
import { buildNotablePlacesFinishDDL, buildNotablePlacesSchemaDDL } from "./schema.js";
import {
  codesQuery,
  DEFAULT_NOTABLE_MIN_SITELINKS,
  DEFAULT_NOTABLE_PLACES_SPARQL_URL,
  descriptionsQuery,
  NOTABLE_CODE_PROPERTIES,
  NOTABLE_DESCRIPTION_LANGUAGES,
  NOTABLE_DISPLAY_LANGUAGES,
  NOTABLE_NAME_LANGUAGES,
  type NotablePlaceKind,
  namesQuery,
  parseEntity,
  parseKind,
  parseLiteral,
  parsePoint,
  placesQuery,
  sparqlRows,
} from "./sparql.js";
import type { NotablePlacesRuntimeState } from "./state.js";

export type NotablePlacesBuildStage =
  | "places"
  | "names"
  | "descriptions"
  | "index"
  | "validate"
  | "publish"
  | "complete";

export interface NotablePlacesBuildProgress {
  stage: NotablePlacesBuildStage;
  message: string;
  placeCount?: number;
  nameCount?: number;
}

export interface NotablePlacesBuildResult {
  epoch: string;
  source: string;
  minSitelinks: number;
  placeCount: number;
  nameCount: number;
}

/** Sitelinks at which a place counts as known beyond its town, and fame there. */
const FAME_FLOOR_SITELINKS = 8;
const FAME_AT_FLOOR = 0.3;
/** Sitelinks of a place known everywhere: the Eiffel Tower has 191, the Colosseum 170. */
const FAME_FULL_SITELINKS = 300;

/**
 * How widely known a place is, 0–1, from how many Wikipedia language editions
 * cover it, on a log scale: 8 editions → 0.3 (worth opening from anywhere),
 * 40 → 0.6, 150 → 0.87, 300 or more → 1.
 */
export function fameFromSitelinks(sitelinks: number): number {
  if (sitelinks <= 0) return 0;
  const fame =
    FAME_AT_FLOOR +
    ((1 - FAME_AT_FLOOR) * Math.log(sitelinks / FAME_FLOOR_SITELINKS)) /
      Math.log(FAME_FULL_SITELINKS / FAME_FLOOR_SITELINKS);
  return Math.min(1, Math.max(0, fame));
}

const BATCH_SIZE = 5_000;
/** Fewer places than this means the endpoint answered with a fragment, not the set. */
const MIN_EXPECTED_PLACES = 1_000;

export interface BuildNotablePlacesOptions {
  sql: postgres.Sql;
  runtimeState: NotablePlacesRuntimeState;
  endpoint?: string;
  minSitelinks?: number;
  operationLock?: SearchIndexOperationLock;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: NotablePlacesBuildProgress) => void;
}

interface PlaceRow {
  qid: string;
  kind: NotablePlaceKind;
  lat: number;
  lng: number;
  sitelinks: number;
}

interface NameRow {
  qid: string;
  lang: string;
  kind: "label" | "alias";
  name: string;
  normalized: string;
}

async function insertPlaces(sql: postgres.Sql, rows: PlaceRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await sql.unsafe(
    `INSERT INTO notable_places__staging.places (qid, kind, lat, lng, sitelinks, fame)
     SELECT * FROM UNNEST($1::TEXT[], $2::TEXT[], $3::DOUBLE PRECISION[],
       $4::DOUBLE PRECISION[], $5::INTEGER[], $6::DOUBLE PRECISION[])
     ON CONFLICT (qid) DO NOTHING`,
    [
      rows.map((row) => row.qid),
      rows.map((row) => row.kind),
      rows.map((row) => row.lat),
      rows.map((row) => row.lng),
      rows.map((row) => row.sitelinks),
      rows.map((row) => fameFromSitelinks(row.sitelinks)),
    ],
  );
  return result.count;
}

/** Names of places outside the set (Wikidata moved on between queries) are dropped. */
async function insertNames(sql: postgres.Sql, rows: NameRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await sql.unsafe(
    `INSERT INTO notable_places__staging.fetched_names (qid, lang, kind, name, normalized)
     SELECT n.qid, n.lang, n.kind, n.name, n.normalized
       FROM UNNEST($1::TEXT[], $2::TEXT[], $3::TEXT[], $4::TEXT[], $5::TEXT[])
         AS n (qid, lang, kind, name, normalized)
       JOIN notable_places__staging.places AS p USING (qid)`,
    [
      rows.map((row) => row.qid),
      rows.map((row) => row.lang),
      rows.map((row) => row.kind),
      rows.map((row) => row.name),
      rows.map((row) => row.normalized),
    ],
  );
  return result.count;
}

async function setCodes(
  sql: postgres.Sql,
  column: "iata" | "icao",
  rows: { qid: string; code: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await sql.unsafe(
    `UPDATE notable_places__staging.places AS p SET ${column} = c.code
       FROM UNNEST($1::TEXT[], $2::TEXT[]) AS c (qid, code)
      WHERE p.qid = c.qid`,
    [rows.map((row) => row.qid), rows.map((row) => row.code)],
  );
}

async function insertDescriptions(
  sql: postgres.Sql,
  lang: string,
  rows: { qid: string; description: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await sql.unsafe(
    `INSERT INTO notable_places__staging.descriptions (qid, lang, description)
     SELECT d.qid, $2, d.description
       FROM UNNEST($1::TEXT[], $3::TEXT[]) AS d (qid, description)
       JOIN notable_places__staging.places AS p USING (qid)
     ON CONFLICT DO NOTHING`,
    [rows.map((row) => row.qid), lang, rows.map((row) => row.description)],
  );
}

async function noteLiveFailure(sql: postgres.Sql, message: string): Promise<void> {
  try {
    const rows = await sql.unsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('notable_places.index_state') IS NOT NULL AS exists`,
    );
    if (rows[0]?.exists) {
      await sql.unsafe(
        `UPDATE notable_places.index_state SET last_error = $1, updated_at = NOW() WHERE singleton = 1`,
        [message],
      );
    }
  } catch {
    // Preserve the original build failure when failure diagnostics cannot be written.
  }
}

/**
 * Downloads the places Wikipedia covers in many languages from a Wikidata
 * SPARQL endpoint and publishes them, with their names in the searchable
 * languages, as the `notable_places` schema. The build fills a staging schema
 * and swaps it in at the end, so searches keep the previous snapshot until
 * the new one is complete and valid.
 */
export async function buildNotablePlaces(
  opts: BuildNotablePlacesOptions,
): Promise<NotablePlacesBuildResult> {
  const endpoint = opts.endpoint ?? DEFAULT_NOTABLE_PLACES_SPARQL_URL;
  const minSitelinks = opts.minSitelinks ?? DEFAULT_NOTABLE_MIN_SITELINKS;
  const lock = opts.operationLock ?? createNotablePlacesOperationLock(opts.sql);
  const fetchOptions = { endpoint, signal: opts.signal, fetchImpl: opts.fetchImpl };
  return lock.run(async () => {
    const startedAt = new Date();
    let stage: NotablePlacesBuildStage = "places";
    let placeCount = 0;
    let nameCount = 0;
    opts.runtimeState.building = true;
    opts.runtimeState.failure = null;
    const progress = (next: NotablePlacesBuildStage, message: string): void => {
      stage = next;
      opts.onProgress?.({ stage, message, placeCount, nameCount });
    };
    try {
      await opts.sql.unsafe(buildNotablePlacesSchemaDDL("notable_places__staging"));
      const epoch = randomUUID();
      await opts.sql.unsafe(
        `INSERT INTO notable_places__staging.index_state
          (source, min_sitelinks, epoch, status, started_at, updated_at)
         VALUES ($1,$2,$3,'building',$4,$4)`,
        [endpoint, minSitelinks, epoch, startedAt],
      );

      progress("places", `Fetching places with at least ${minSitelinks} sitelinks`);
      let batch: PlaceRow[] = [];
      for await (const [item, coord, links, found] of sparqlRows(
        placesQuery(minSitelinks),
        fetchOptions,
      )) {
        const qid = parseEntity(item ?? "");
        const point = parsePoint(coord ?? "");
        const kind = parseKind(found ?? "");
        // QLever writes numbers bare ("191"); other endpoints quote and type them.
        const sitelinks = Number(parseLiteral(links ?? "") ?? links);
        if (!qid || !point || !kind || !Number.isFinite(sitelinks)) continue;
        batch.push({ qid, kind, lng: point[0], lat: point[1], sitelinks });
        if (batch.length >= BATCH_SIZE) {
          placeCount += await insertPlaces(opts.sql, batch);
          batch = [];
        }
      }
      placeCount += await insertPlaces(opts.sql, batch);

      for (const lang of NOTABLE_NAME_LANGUAGES) {
        for (const kind of ["label", "alias"] as const) {
          progress("names", `Fetching ${kind === "label" ? "labels" : "aliases"} in ${lang}`);
          let names: NameRow[] = [];
          for await (const [item, value] of sparqlRows(
            namesQuery(lang, kind, minSitelinks),
            fetchOptions,
          )) {
            const qid = parseEntity(item ?? "");
            const name = parseLiteral(value ?? "")?.trim();
            const normalized = name ? normalizeSearchTerm(name) : "";
            if (!qid || !name || !normalized) continue;
            names.push({ qid, lang, kind, name, normalized });
            if (names.length >= BATCH_SIZE) {
              nameCount += await insertNames(opts.sql, names);
              names = [];
            }
          }
          nameCount += await insertNames(opts.sql, names);
        }
      }

      for (const [column, property] of Object.entries(NOTABLE_CODE_PROPERTIES)) {
        progress("names", `Fetching ${column.toUpperCase()} codes`);
        const codes: { qid: string; code: string }[] = [];
        for await (const [item, value] of sparqlRows(
          codesQuery(property, minSitelinks),
          fetchOptions,
        )) {
          const qid = parseEntity(item ?? "");
          const code = parseLiteral(value ?? "")?.trim();
          if (qid && code && /^[A-Z0-9]{3,4}$/.test(code)) codes.push({ qid, code });
        }
        await setCodes(opts.sql, column as keyof typeof NOTABLE_CODE_PROPERTIES, codes);
      }

      for (const lang of NOTABLE_DESCRIPTION_LANGUAGES) {
        progress("descriptions", `Fetching descriptions in ${lang}`);
        let descriptions: { qid: string; description: string }[] = [];
        for await (const [item, value] of sparqlRows(
          descriptionsQuery(lang, minSitelinks),
          fetchOptions,
        )) {
          const qid = parseEntity(item ?? "");
          const description = parseLiteral(value ?? "")?.trim();
          if (!qid || !description) continue;
          descriptions.push({ qid, description });
          if (descriptions.length >= BATCH_SIZE) {
            await insertDescriptions(opts.sql, lang, descriptions);
            descriptions = [];
          }
        }
        await insertDescriptions(opts.sql, lang, descriptions);
      }

      progress("index", "Folding names and building indexes");
      await opts.sql.unsafe(
        buildNotablePlacesFinishDDL("notable_places__staging", NOTABLE_DISPLAY_LANGUAGES),
      );

      progress("validate", "Validating the staged snapshot");
      const counts = await opts.sql.unsafe<{ places: string; names: string; unnamed: string }[]>(
        `SELECT
           (SELECT COUNT(*) FROM notable_places__staging.places)::TEXT AS places,
           (SELECT COUNT(*) FROM notable_places__staging.names)::TEXT AS names,
           (SELECT COUNT(*) FROM notable_places__staging.places p
             WHERE NOT EXISTS (SELECT 1 FROM notable_places__staging.names n
                                WHERE n.qid = p.qid))::TEXT AS unnamed`,
      );
      placeCount = Number(counts[0]?.places ?? 0);
      nameCount = Number(counts[0]?.names ?? 0);
      if (placeCount < MIN_EXPECTED_PLACES) {
        throw new Error(
          `only ${placeCount} places arrived; expected at least ${MIN_EXPECTED_PLACES}`,
        );
      }
      if (nameCount < placeCount / 2) {
        throw new Error(`only ${nameCount} names arrived for ${placeCount} places`);
      }
      // A place with no name in any searchable language can never be found.
      await opts.sql.unsafe(
        `DELETE FROM notable_places__staging.places p
          WHERE NOT EXISTS (SELECT 1 FROM notable_places__staging.names n WHERE n.qid = p.qid)`,
      );
      placeCount -= Number(counts[0]?.unnamed ?? 0);

      progress("publish", "Publishing the validated snapshot");
      const live = await opts.sql.unsafe<{ exists: boolean }[]>(
        `SELECT to_regnamespace('notable_places') IS NOT NULL AS exists`,
      );
      await opts.sql.begin(async (transaction) => {
        await transaction.unsafe(
          `UPDATE notable_places__staging.index_state
              SET status='ready', place_count=$1, name_count=$2, published_at=NOW(),
                  updated_at=NOW(), last_error=NULL
            WHERE singleton=1`,
          [placeCount, nameCount],
        );
        await transaction.unsafe(`DROP SCHEMA IF EXISTS notable_places__previous CASCADE`);
        if (live[0]?.exists) {
          await transaction.unsafe(
            `ALTER SCHEMA notable_places RENAME TO notable_places__previous`,
          );
        }
        await transaction.unsafe(`ALTER SCHEMA notable_places__staging RENAME TO notable_places`);
        await transaction.unsafe(`DROP SCHEMA IF EXISTS notable_places__previous CASCADE`);
      });
      progress("complete", `Published ${placeCount} places and ${nameCount} names`);
      return { epoch, source: endpoint, minSitelinks, placeCount, nameCount };
    } catch (error) {
      const message = scrubSecrets(`[${stage}] ${(error as Error).message}`);
      try {
        await opts.sql.unsafe(`DROP SCHEMA IF EXISTS notable_places__staging CASCADE`);
      } catch {
        /* keep original error */
      }
      await noteLiveFailure(opts.sql, message);
      opts.runtimeState.failure = { error: message, at: new Date().toISOString() };
      throw new Error(message, { cause: error });
    } finally {
      opts.runtimeState.building = false;
    }
  });
}
