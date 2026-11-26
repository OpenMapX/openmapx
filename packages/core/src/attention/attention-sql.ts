import {
  ATTENTION_SEVERITIES,
  type AttentionInput,
} from "../api/contracts/integration-admin/attention";

/** An attention item that has already been shortened and parsed against `attentionInputSchema`. */
export type AttentionUpsertInput = AttentionInput;

/**
 * The severities as a SQL array literal, lowest first, so `array_position`
 * ranks a severity in SQL exactly as `ATTENTION_SEVERITIES` orders it.
 */
export const ATTENTION_SEVERITY_ORDER_SQL = `ARRAY[${ATTENTION_SEVERITIES.map((severity) => `'${severity}'`).join(",")}]`;
const ORDER = ATTENTION_SEVERITY_ORDER_SQL;

// One statement, so concurrent raises of one key serialise on the row lock and
// the host CLI, which has no API code, applies the same occurrence and
// acknowledgement rules with a plain SQL client. Its `WHERE` makes an
// unchanged raise, or one an administrator has already acknowledged, write
// nothing. The insert reads `old` so that `old` locks and reads the row before
// it changes: a `FOR UPDATE` scan run after the same statement has updated a
// row skips that row, and every update would then report `inserted`.
//
// Every parameter is declared `text`, so no client chooses its own encoding:
// a postgres.js client without drizzle would otherwise serialise a `jsonb`
// parameter a second time and store the action as a JSON string. The optional
// parameters treat empty text as absent, because `psql \bind` cannot send
// NULL; the input contract already refuses an empty detail or reference.
const ATTENTION_UPSERT_SQL = `WITH old AS (
  SELECT severity, acknowledged_at, occurrence_ref FROM attention_item WHERE key = $1::text FOR UPDATE
), written AS (
  INSERT INTO attention_item AS item (key, severity, source, title, detail, action, clearance, occurrence_ref)
  SELECT $1::text, $2::text, $3::text, $4::text, NULLIF($5::text, ''), NULLIF($6::text, '')::jsonb,
    COALESCE(NULLIF($7::text, ''), 'condition'), NULLIF($8::text, '')
  FROM (SELECT count(*) FROM old) AS locked
  ON CONFLICT (key) DO UPDATE SET
    severity = EXCLUDED.severity, source = EXCLUDED.source, title = EXCLUDED.title,
    detail = EXCLUDED.detail, action = EXCLUDED.action, clearance = EXCLUDED.clearance,
    occurrence_ref = EXCLUDED.occurrence_ref, updated_at = now(),
    raised_at = CASE WHEN EXCLUDED.occurrence_ref IS NOT NULL
        AND EXCLUDED.occurrence_ref IS DISTINCT FROM item.occurrence_ref
      THEN now() ELSE item.raised_at END,
    acknowledged_at = CASE
      WHEN EXCLUDED.occurrence_ref IS NOT NULL AND EXCLUDED.occurrence_ref IS DISTINCT FROM item.occurrence_ref THEN NULL
      WHEN array_position(${ORDER}, EXCLUDED.severity)
         > array_position(${ORDER}, item.severity) THEN NULL
      ELSE item.acknowledged_at END
  WHERE (item.severity, item.source, item.title, item.detail, item.action, item.clearance, item.occurrence_ref)
      IS DISTINCT FROM (EXCLUDED.severity, EXCLUDED.source, EXCLUDED.title, EXCLUDED.detail, EXCLUDED.action, EXCLUDED.clearance, EXCLUDED.occurrence_ref)
    AND NOT (item.acknowledged_at IS NOT NULL
      AND item.occurrence_ref IS NOT DISTINCT FROM EXCLUDED.occurrence_ref
      AND array_position(${ORDER}, EXCLUDED.severity)
       <= array_position(${ORDER}, item.severity))
  RETURNING 1
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM written) THEN 'unchanged'
  WHEN NOT EXISTS (SELECT 1 FROM old) THEN 'inserted'
  WHEN NULLIF($8::text, '') IS NOT NULL
    AND NULLIF($8::text, '') IS DISTINCT FROM (SELECT occurrence_ref FROM old) THEN 'inserted'
  WHEN array_position(${ORDER}, $2::text)
     > array_position(${ORDER}, (SELECT severity FROM old)) THEN 'escalated'
  ELSE 'changed' END AS outcome`;

/**
 * The statement that raises or updates one attention item, returning one row
 * `{ outcome }` of `inserted`, `escalated`, `changed` or `unchanged`.
 *
 * Any client may run it, as long as it passes each value as text:
 * - `$1` key, `$2` severity, `$3` source, `$4` title: required, as given.
 * - `$5` detail, `$8` occurrence reference: the text, or NULL or `''` when absent.
 * - `$6` action: the action object serialised as JSON text (`JSON.stringify`),
 *   never a JSON value the client encodes itself; NULL or `''` when absent.
 * - `$7` clearance: `condition` or `acknowledge`; NULL or `''` mean `condition`.
 *
 * `values` holds them in that order, with NULL for an absent value. A client
 * that cannot send NULL, such as `psql \bind`, passes `''` instead.
 */
export function attentionUpsertStatement(input: AttentionUpsertInput): {
  text: string;
  values: (string | null)[];
} {
  return {
    text: ATTENTION_UPSERT_SQL,
    values: [
      input.key,
      input.severity,
      input.source,
      input.title,
      input.detail ?? null,
      input.action ? JSON.stringify(input.action) : null,
      input.clearance ?? "condition",
      input.occurrenceRef ?? null,
    ],
  };
}
