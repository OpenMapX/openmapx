import {
  ATTENTION_DETAIL_MAX_LENGTH,
  ATTENTION_TITLE_MAX_LENGTH,
  type AttentionInput,
  type AttentionItem,
  attentionInputSchema,
} from "@openmapx/core/api-contracts";
import { ATTENTION_SEVERITY_ORDER_SQL, attentionUpsertStatement } from "@openmapx/core/attention";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { attentionItem, attentionNotification } from "../db/schema";

export type AttentionRaiseOutcome = "inserted" | "escalated" | "changed" | "unchanged";

/**
 * Cuts `text` to `max` characters, ending in `…` when it cuts. A surrogate
 * pair is never split, so the stored text stays valid UTF-16.
 */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = text.slice(0, max - 1);
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return `${kept}…`;
}

/**
 * Raises an item or updates the stored one. The texts are shortened rather
 * than refused: callers build them from unbounded inputs such as an
 * extension's name, and a long text must not lose the item. Throws a
 * `ZodError` for a malformed key, severity, source, action, clearance or
 * occurrence reference, or an empty title.
 */
export async function raiseAttention(
  input: AttentionInput,
  database?: typeof db,
): Promise<AttentionRaiseOutcome> {
  const { detail, ...rest } = input;
  const parsed = attentionInputSchema.parse({
    ...rest,
    title: shorten(input.title, ATTENTION_TITLE_MAX_LENGTH),
    ...(detail ? { detail: shorten(detail, ATTENTION_DETAIL_MAX_LENGTH) } : {}),
  });
  const { text, values } = attentionUpsertStatement(parsed);
  const [row] = await (database ?? db).$client.unsafe<{ outcome: AttentionRaiseOutcome }[]>(
    text,
    values,
  );
  if (!row) throw new Error("The attention statement returned no outcome");
  return row.outcome;
}

/** Forgets an item once the condition that raised it is gone. */
export async function resolveAttention(key: string, database?: typeof db): Promise<void> {
  await (database ?? db).delete(attentionItem).where(eq(attentionItem.key, key));
}

/**
 * The keys of the stored items that start with `prefix`, acknowledged or
 * not, for a source that resolves its own items once their condition is gone.
 */
export async function listAttentionKeys(prefix: string, database?: typeof db): Promise<string[]> {
  const rows = await (database ?? db)
    .select({ key: attentionItem.key })
    .from(attentionItem)
    .where(sql`starts_with(${attentionItem.key}, ${prefix})`);
  return rows.map((row) => row.key);
}

/**
 * Marks an item acknowledged and cancels its notifications that have not been
 * sent yet. Returns `false`, changing nothing, for an unknown key.
 */
export async function acknowledgeAttention(key: string, database?: typeof db): Promise<boolean> {
  return (database ?? db).transaction(async (tx) => {
    const acknowledged = await tx
      .update(attentionItem)
      .set({ acknowledgedAt: sql`now()` })
      .where(eq(attentionItem.key, key))
      .returning({ key: attentionItem.key });
    if (acknowledged.length === 0) return false;
    await tx
      .update(attentionNotification)
      .set({ status: "canceled", updatedAt: sql`now()` })
      .where(
        and(
          eq(attentionNotification.attentionKey, key),
          inArray(attentionNotification.status, ["pending", "retryable"]),
        ),
      );
    return true;
  });
}

/**
 * The items to show: an acknowledged `acknowledge` item is done and left out,
 * an acknowledged `condition` item stays, after the unacknowledged ones of its
 * severity, until its source clears it.
 */
export async function listAttention(database?: typeof db): Promise<AttentionItem[]> {
  const rows = await (database ?? db)
    .select()
    .from(attentionItem)
    .where(or(ne(attentionItem.clearance, "acknowledge"), isNull(attentionItem.acknowledgedAt)))
    .orderBy(
      sql`array_position(${sql.raw(ATTENTION_SEVERITY_ORDER_SQL)}, ${attentionItem.severity}) DESC`,
      sql`${attentionItem.acknowledgedAt} IS NOT NULL`,
      desc(attentionItem.raisedAt),
      asc(attentionItem.key),
    );
  return rows.map((row) => ({
    key: row.key,
    severity: row.severity,
    source: row.source,
    title: row.title,
    detail: row.detail,
    action: row.action,
    clearance: row.clearance,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    raisedAt: row.raisedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}
