/** Desired binding fingerprints. Values are service IDs, never credentials. */
import { createHash } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "../db";
import { capabilityBinding, integrationBindingRevision } from "../db/schema";
import {
  type AdministrativeConfigurationReadContext,
  assertAdministrativeConfigurationRead,
} from "./administrative-configuration-context";
export type BindingRow = typeof capabilityBinding.$inferSelect & { _rowVersion?: string };
export type BindingVersion = typeof integrationBindingRevision.$inferSelect & {
  _rowVersion?: string;
};
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function bindingState(
  integrationId: string,
  allRows: readonly BindingRow[],
  allVersions: readonly BindingVersion[],
) {
  const rows = allRows
      .filter((row) => row.integrationId === integrationId)
      .sort((a, b) => a.capability.localeCompare(b.capability)),
    versions = allVersions.filter((row) => row.integrationId === integrationId);
  if (versions.length > 1 || new Set(rows.map((row) => row.capability)).size !== rows.length)
    throw Error("Binding authority unavailable");
  for (const row of [...rows, ...versions])
    if (typeof row._rowVersion !== "string" || !/^\d+$/.test(row._rowVersion))
      throw Error("Binding row version unavailable");
  const bindings = Object.fromEntries(rows.map((row) => [row.capability, row.serviceId]));
  return {
    rows,
    bindings,
    version: versions[0] ?? null,
    revision: digest({
      integrationId,
      rows: rows.map((row) => ({
        capability: row.capability,
        serviceId: row.serviceId,
        rowVersion: row._rowVersion,
      })),
      version: versions[0] ?? null,
    }),
    desiredRevision: bindingContentRevision(integrationId, bindings),
  };
}
export const bindingContentRevision = (
  integrationId: string,
  bindings: Readonly<Record<string, string>>,
) => digest({ integrationId, bindings });
export function capturedBindingState(
  context: AdministrativeConfigurationReadContext,
  integrationId: string,
) {
  assertAdministrativeConfigurationRead(context);
  if (!context.bindingRows || !context.bindingRevisionRows)
    throw Error("Captured binding authority unavailable");
  return bindingState(integrationId, context.bindingRows, context.bindingRevisionRows);
}
export async function readBindingState(
  integrationId: string,
  database: Pick<typeof db, "select"> = db,
) {
  const rows = await database
    .select({ ...getTableColumns(capabilityBinding), _rowVersion: sql<string>`xmin::text` })
    .from(capabilityBinding)
    .where(eq(capabilityBinding.integrationId, integrationId));
  const versions = await database
    .select({
      ...getTableColumns(integrationBindingRevision),
      _rowVersion: sql<string>`xmin::text`,
    })
    .from(integrationBindingRevision)
    .where(eq(integrationBindingRevision.integrationId, integrationId));
  return bindingState(integrationId, rows, versions);
}
