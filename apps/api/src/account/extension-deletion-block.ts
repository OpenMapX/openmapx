import { EXTENSION_SCHEMA_PATTERN } from "@openmapx/core/component-id";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { installedIntegrations } from "../privacy/extension-handlers";
import { plainExtensionName } from "../privacy/extension-subject-data";
import { processLogger } from "../process-logger";
import { raiseAttention } from "../services/attention";

/** The foreign-key refusals PostgreSQL reports for a delete: `RESTRICT` and `NO ACTION`. */
const REFUSING_KEY_CODES = new Set(["23001", "23503"]);

interface KeyRefusal {
  constraint: string;
  /** The table PostgreSQL names in the error, which for a delete is the referenced one. */
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

/**
 * The schema and table that hold the refusing key. For a delete PostgreSQL
 * names the referenced table, which is `public."user"` for a key straight to
 * the account; the key's own table names the extension.
 */
async function keyOwner(refusal: KeyRefusal): Promise<{ schema: string; table: string }> {
  const rows = await db.execute<{ schema: string; table: string }>(sql`
    select n.nspname::text as schema, c.relname::text as table
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where k.contype = 'f'
      and k.conname = ${refusal.constraint}
      and k.confrelid = to_regclass(format('%I.%I', ${refusal.schema}::text, ${refusal.table}::text))
    limit 1`);
  return rows[0] ?? { schema: refusal.schema, table: refusal.table };
}

/** The integration id an `ext_` schema belongs to: the id with hyphens as underscores. */
function schemaIntegrationId(schema: string): string | null {
  return EXTENSION_SCHEMA_PATTERN.test(schema) ? schema.slice(4).replaceAll("_", "-") : null;
}

export function accountDeletionBlockedAttentionKey(integrationId: string): string {
  return `account-deletion-blocked:${integrationId}`;
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
  let owner: { schema: string; table: string };
  try {
    owner = await keyOwner(refusal);
  } catch {
    owner = { schema: refusal.schema, table: refusal.table };
  }
  const { schema, table } = schemaIntegrationId(owner.schema) ? owner : refusal;
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
      key: accountDeletionBlockedAttentionKey(integrationId),
      severity: "warning",
      source: "privacy",
      // Nothing observes the key once the deletion failed; the administrator
      // acknowledges the item after dealing with the extension.
      clearance: "acknowledge",
      title: `${name} blocks account deletion`,
      detail: `${name}'s foreign key ${refusal.constraint} on table ${table} refused an account deletion. Update or remove the extension, then the person can delete the account again.`,
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
