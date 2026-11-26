import type { AttentionInput } from "../api/contracts/integration-admin/attention";

/** An attention item that has already been shortened and parsed against `attentionInputSchema`. */
export type AttentionUpsertInput = AttentionInput;

// One statement, so concurrent raises of one key serialise on the row lock and
// the host CLI, which has no API code, applies the same occurrence and
// acknowledgement rules with a plain SQL client. Its `WHERE` makes an
// unchanged raise, or one an administrator has already acknowledged, write
// nothing. The insert reads `old` so that `old` locks and reads the row before
// it changes: a `FOR UPDATE` scan run after the same statement has updated a
// row skips that row, and every update would then report `inserted`.
const ATTENTION_UPSERT_SQL = `WITH old AS (
  SELECT severity, acknowledged_at, occurrence_ref FROM attention_item WHERE key = $1::text FOR UPDATE
), written AS (
  INSERT INTO attention_item AS item (key, severity, source, title, detail, action, clearance, occurrence_ref)
  SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::text, $8::text
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
      WHEN array_position(ARRAY['info','warning','critical'], EXCLUDED.severity)
         > array_position(ARRAY['info','warning','critical'], item.severity) THEN NULL
      ELSE item.acknowledged_at END
  WHERE (item.severity, item.source, item.title, item.detail, item.action, item.clearance, item.occurrence_ref)
      IS DISTINCT FROM (EXCLUDED.severity, EXCLUDED.source, EXCLUDED.title, EXCLUDED.detail, EXCLUDED.action, EXCLUDED.clearance, EXCLUDED.occurrence_ref)
    AND NOT (item.acknowledged_at IS NOT NULL
      AND item.occurrence_ref IS NOT DISTINCT FROM EXCLUDED.occurrence_ref
      AND array_position(ARRAY['info','warning','critical'], EXCLUDED.severity)
       <= array_position(ARRAY['info','warning','critical'], item.severity))
  RETURNING 1
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM written) THEN 'unchanged'
  WHEN NOT EXISTS (SELECT 1 FROM old) THEN 'inserted'
  WHEN $8::text IS NOT NULL AND $8::text IS DISTINCT FROM (SELECT occurrence_ref FROM old) THEN 'inserted'
  WHEN array_position(ARRAY['info','warning','critical'], $2::text)
     > array_position(ARRAY['info','warning','critical'], (SELECT severity FROM old)) THEN 'escalated'
  ELSE 'changed' END AS outcome`;

/**
 * The statement that raises or updates one attention item, returning one row
 * `{ outcome }` of `inserted`, `escalated`, `changed` or `unchanged`.
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
