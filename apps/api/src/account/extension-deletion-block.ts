import { createHash } from "node:crypto";
import { EXTENSION_SCHEMA_PATTERN } from "@openmapx/core/component-id";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { installedIntegrations } from "../privacy/extension-handlers";
import { plainExtensionName } from "../privacy/extension-subject-data";
import { processLogger } from "../process-logger";
import { listAttentionKeys, raiseAttention, resolveAttention } from "../services/attention";

/** The foreign-key refusals PostgreSQL reports for a delete: `RESTRICT` and `NO ACTION`. */
const REFUSING_KEY_CODES = new Set(["23001", "23503"]);

interface KeyRefusal {
  constraint: string;
  /**
   * The table that holds the key. PostgreSQL names it in the error also for a
   * delete on the referenced table, so no lookup is needed, and the daily run
   * that resolves the item looks at the same table.
   */
  schema: string;
  table: string;
}

/** The refusing foreign key in an error chain, as PostgreSQL reports it. */
function keyRefusal(error: unknown): KeyRefusal | null {
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    const item = current as Record<string, unknown>;
    if (
      typeof item.code === "string" &&
      REFUSING_KEY_CODES.has(item.code) &&
      typeof item.constraint_name === "string" &&
      typeof item.schema_name === "string" &&
      typeof item.table_name === "string"
    )
      return {
        constraint: item.constraint_name,
        schema: item.schema_name,
        table: item.table_name,
      };
    current = item.cause;
  }
  return null;
}

/** The integration id an `ext_` schema belongs to: the id with hyphens as underscores. */
function schemaIntegrationId(schema: string): string | null {
  return EXTENSION_SCHEMA_PATTERN.test(schema) ? schema.slice(4).replaceAll("_", "-") : null;
}

const ATTENTION_KEY_PREFIX = "account-deletion-blocked:";

/**
 * One item per refusing key. A constraint name may hold characters an
 * attention key cannot, so the key carries a digest of where it is.
 */
export function accountDeletionBlockedAttentionKey(
  integrationId: string,
  key: { schema: string; table: string; constraint: string },
): string {
  const digest = createHash("sha256")
    .update(`${key.schema}\0${key.table}\0${key.constraint}`)
    .digest("hex")
    .slice(0, 16);
  return `${ATTENTION_KEY_PREFIX}${integrationId}:${digest}`;
}

/**
 * Resolves the items of keys that no longer refuse a deletion: dropped,
 * changed to ON DELETE CASCADE, or gone with their schema. SET NULL and SET
 * DEFAULT still count as refusing, since a NOT NULL column or a default no
 * row matches makes them fail too. Nothing else observes such a key once the
 * deletion failed, so the daily run asks.
 */
export async function resolveClearedDeletionBlocks(): Promise<void> {
  const keys = await listAttentionKeys(ATTENTION_KEY_PREFIX);
  if (keys.length === 0) return;
  const refusing = await db.execute<{ schema: string; table: string; constraint: string }>(sql`
    select n.nspname::text as schema, c.relname::text as table, k.conname::text as constraint
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where k.contype = 'f' and k.confdeltype <> 'c' and starts_with(n.nspname, 'ext_')`);
  const live = new Set<string>();
  for (const row of refusing) {
    const integrationId = schemaIntegrationId(row.schema);
    if (integrationId) live.add(accountDeletionBlockedAttentionKey(integrationId, row));
  }
  for (const key of keys) if (!live.has(key)) await resolveAttention(key);
}

/**
 * The migration check judges only the keys an integration's own files add.
 * A key added another way (another integration's migration, `ctx.db`) can
 * still refuse an account deletion. The deletion then fails as PostgreSQL
 * decided; this tells the operator which extension refused, raises an
 * attention item and answers with a conflict the client can explain, instead
 * of a generic server error. Returns normally when the error is not such a
 * refusal.
 */
export async function throwIfExtensionBlocksDeletion(error: unknown): Promise<void> {
  const refusal = keyRefusal(error);
  if (!refusal) return;
  const { schema, table } = refusal;
  const integrationId = schemaIntegrationId(schema);
  if (!integrationId) return;
  processLogger.error(
    { integrationId, schema, table, constraint: refusal.constraint },
    "An extension's foreign key refused an account deletion",
  );
  const integration = installedIntegrations()?.find(({ id }) => id === integrationId);
  const name = plainExtensionName(integration, integrationId);
  try {
    await raiseAttention({
      key: accountDeletionBlockedAttentionKey(integrationId, {
        schema,
        table,
        constraint: refusal.constraint,
      }),
      severity: "warning",
      source: "privacy",
      // The daily run resolves it once the key no longer refuses; an
      // administrator may dismiss it before.
      clearance: "acknowledge",
      title: `${name} blocks account deletion`,
      detail: `${name}'s table ${schema}.${table} holds the foreign key ${refusal.constraint}, which refused an account deletion; the account was left unchanged. Deleting accounts works again once this key is changed to ON DELETE CASCADE or dropped, by an update of the extension that owns the table or of the extension whose migration added the key. Removing the extension alone keeps its schema and this key. This item resolves itself at the next daily check once the key no longer refuses deletions; then ask the person to delete the account again.`,
    });
  } catch (raiseError) {
    processLogger.warn(
      { err: raiseError, integrationId },
      "Could not raise the attention item for a blocked account deletion",
    );
  }
  throw new APIError("CONFLICT", {
    code: "EXTENSION_BLOCKS_ACCOUNT_DELETION",
    message:
      "An installed extension keeps this account from being deleted; the administrator has been told",
  });
}
