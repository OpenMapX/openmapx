import type { Sql } from "postgres";
import { scrubSecrets } from "../../utils/scrub-secrets.js";
import type { PoiRefreshStreamEvidence } from "./types.js";

/** The subset of postgres-js exposed by both a root client and a transaction. */
export type PoiEvidenceSql = Pick<Sql, "unsafe">;

export type PoiRefreshStream = "static" | "live";

export type PoiRefreshStreamPatch = Partial<PoiRefreshStreamEvidence>;

export function emptyPoiRefreshStreamEvidence(): PoiRefreshStreamEvidence {
  return {
    activeVersion: null,
    lastSuccessfullyCheckedVersion: null,
    lastSuccessfulCheckAt: null,
    lastPublishedVersion: null,
    lastPublishedAt: null,
    rowCount: null,
    upstreamAsOf: null,
    upstreamAsOfMin: null,
    upstreamAsOfMax: null,
    expiresAt: null,
    activeAssociation: null,
    pendingWriteIntentId: null,
    lastAttempt: {
      at: null,
      outcome: "unknown",
      jobId: null,
    },
  };
}

/**
 * Merge one stream's evidence without replacing the other stream or erasing
 * historical successful publication fields. The merge happens in Postgres so
 * a concurrent static/live run cannot win by last-writer-wins JSON clobbering.
 */
export async function mergePoiRefreshEvidence(
  sql: PoiEvidenceSql,
  input: {
    sourceId: string;
    domain: string;
    stream: PoiRefreshStream;
    patch: PoiRefreshStreamPatch;
    insertStatus?: string;
    /**
     * Finalization guard for a Redis write intent. A different pending intent
     * means a newer live attempt owns the stream and this patch must not clear
     * or overwrite it.
     */
    pendingWriteIntentGuard?: string;
  },
): Promise<void> {
  const patch = scrubEvidence(input.patch);
  const stream = emptyPoiRefreshStreamEvidence();
  const { lastAttempt, ...streamPatch } = patch;
  Object.assign(stream, streamPatch);
  if (lastAttempt) {
    stream.lastAttempt = {
      ...stream.lastAttempt,
      ...lastAttempt,
      message:
        lastAttempt.message === undefined || lastAttempt.message === null
          ? (lastAttempt.message ?? null)
          : scrubSecrets(String(lastAttempt.message)).slice(0, 2_000),
    };
  }

  // The stream key is a parameter rather than interpolated SQL. The values
  // are JSONB parameters, and the source id remains a normal positional
  // parameter, so neither source metadata nor stage errors become SQL. The
  // conflict branch is guarded in Postgres: an older completion cannot erase
  // a newer pending intent or replace a newer attempt timestamp.
  await sql.unsafe(
    `INSERT INTO "data_manager"."poi_feed_state"
       ("source_id", "domain", "status", "consecutive_failures", "refresh_evidence")
     VALUES ($1, $2, $6, 0,
       jsonb_build_object('version', 1, $3::text, $5::jsonb))
     ON CONFLICT ("source_id") DO UPDATE SET
       "domain" = EXCLUDED."domain",
       "refresh_evidence" = jsonb_set(
         COALESCE("poi_feed_state"."refresh_evidence", '{"version":1}'::jsonb),
         ARRAY[$3::text],
         CASE
           WHEN $7::text IS NOT NULL
             AND (
               COALESCE("poi_feed_state"."refresh_evidence", '{"version":1}'::jsonb)
                 -> $3::text ->> 'pendingWriteIntentId'
             ) IS DISTINCT FROM $7::text
             THEN COALESCE(NULLIF("poi_feed_state"."refresh_evidence" -> $3::text, 'null'::jsonb), '{}'::jsonb)
           WHEN (
             COALESCE("poi_feed_state"."refresh_evidence", '{"version":1}'::jsonb)
               -> $3::text -> 'lastAttempt' ->> 'at'
           ) IS NOT NULL
             AND ($4::jsonb -> 'lastAttempt' ->> 'at') IS NOT NULL
             AND (
               COALESCE("poi_feed_state"."refresh_evidence", '{"version":1}'::jsonb)
                 -> $3::text -> 'lastAttempt' ->> 'at'
             ) > ($4::jsonb -> 'lastAttempt' ->> 'at')
             THEN COALESCE(NULLIF("poi_feed_state"."refresh_evidence" -> $3::text, 'null'::jsonb), '{}'::jsonb)
           ELSE COALESCE(NULLIF("poi_feed_state"."refresh_evidence" -> $3::text, 'null'::jsonb), '{}'::jsonb) || $4::jsonb
         END,
         true
       )`,
    [
      input.sourceId,
      input.domain,
      input.stream,
      JSON.stringify(patch),
      JSON.stringify(stream),
      input.insertStatus ?? "unknown",
      input.pendingWriteIntentGuard ?? null,
    ],
  );
}

function scrubEvidence(patch: PoiRefreshStreamPatch): PoiRefreshStreamPatch {
  const out: PoiRefreshStreamPatch = { ...patch };
  if (patch.lastAttempt) {
    out.lastAttempt = {
      ...patch.lastAttempt,
      ...(patch.lastAttempt.message
        ? { message: scrubSecrets(String(patch.lastAttempt.message)).slice(0, 2_000) }
        : {}),
    };
  }
  return out;
}
