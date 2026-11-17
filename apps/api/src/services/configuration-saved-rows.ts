/** The configuration rows a save wrote, by row version, so a later step can check
 * they are still the ones it saved. No desired values or secret material. */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import type { ConfigurationWriteTransaction } from "./administrative-configuration-writer";

const version = z.string().regex(/^\d{1,10}$/),
  id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const configurationSavedRowSchema = z
  .strictObject({
    kind: z.enum([
      "service-config",
      "integration-config",
      "service-secret",
      "integration-secret",
      "platform",
    ]),
    ownerId: id,
    key: z.string().min(1).max(128).optional(),
    rowId: z.string().min(1).max(128),
    rowVersion: version.nullable(),
    previousRowVersion: version.nullable(),
    state: z.enum(["present", "absent"]),
  })
  .refine(
    (row) =>
      (row.kind !== "platform" ||
        (row.ownerId === "platform" &&
          row.rowId === "platformConfiguration" &&
          row.state === "present")) &&
      row.kind.endsWith("secret") === (row.key !== undefined) &&
      (row.state === "present" ? row.rowVersion !== null : row.rowVersion === null),
  );
export type ConfigurationSavedRow = z.infer<typeof configurationSavedRowSchema>;
/** Actual row versions on the SAME physical writer transaction. No desired
 * values or hashes of secret material enter this receipt or its checksum. */
export async function assertConfigurationSavedRows(
  tx: ConfigurationWriteTransaction,
  input: readonly ConfigurationSavedRow[],
): Promise<void> {
  const rows = z.array(configurationSavedRowSchema).max(512).parse(input);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.kind}:${row.ownerId}:${row.key ?? ""}`;
    if (seen.has(key)) throw Error("Configuration saved row ownership changed");
    seen.add(key);
    if (row.kind === "platform") {
      const [actual] = await tx
        .select({ version: sql<string>`xmin::text` })
        .from(schema.systemSettings)
        .where(eq(schema.systemSettings.key, "platformConfiguration"));
      if (actual?.version !== row.rowVersion)
        throw Error("Configuration saved row ownership changed");
      continue;
    }
    const table =
      row.kind === "service-config"
        ? schema.serviceConfig
        : row.kind === "integration-config"
          ? schema.integrationConfig
          : row.kind === "service-secret"
            ? schema.serviceSecret
            : schema.integrationSecret;
    const ownerColumn = "serviceId" in table ? table.serviceId : table.integrationId,
      where =
        row.key !== undefined && "key" in table
          ? sql`${ownerColumn} = ${row.ownerId} AND ${table.key} = ${row.key}`
          : eq(ownerColumn, row.ownerId),
      actual = await tx
        .select({ id: table.id, version: sql<string>`xmin::text` })
        .from(table)
        .where(where);
    if (
      row.state === "absent"
        ? actual.length !== 0
        : actual.length !== 1 ||
          actual[0]!.id !== row.rowId ||
          actual[0]!.version !== row.rowVersion
    )
      throw Error("Configuration saved row ownership changed");
  }
}
