/** Fixed non-secret DB decision data. Decoding/checksums confer no authority;
 * producers and delivery read these only under the actual owned job row lock. */
import { createHash } from "node:crypto";
import {
  type ConfigurationMaintenanceDecision,
  canonicalJson,
  configurationMaintenanceDecisionSchema,
} from "@openmapx/core/ops";
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
/** Written ONLY by the fixed desired-transaction catch after the actual SAME
 * connection's awaited ROLLBACK acknowledgement. No error/value is serialized. */
export const configurationMaintenanceRollbackCheckpointSchema = z.strictObject({
  version: z.literal(1),
  disposition: z.literal("known_rolled_back"),
  rollbackId: z.uuid(),
  candidateId: z.uuid(),
  maintenanceId: z.uuid(),
  prepareOperationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  prepareFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checkpointVersion: z.number().int().positive().safe(),
});
const parent = z.strictObject({
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  deadlineAt: z.number().int().nonnegative().safe(),
});
export const configurationMaintenanceDecisionCheckpointSchema = z
  .strictObject({
    version: z.literal(1),
    operation: configurationMaintenanceDecisionSchema,
    rowVersions: z
      .array(configurationSavedRowSchema)
      .max(512)
      .refine((rows) => Buffer.byteLength(canonicalJson(rows)) <= 65536),
    attempt: z.enum(["not_attempted", "attempted"]),
    delivery: z
      .strictObject({
        stepAddress: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
        root: z.strictObject({
          operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
          requestedDeadlineAt: z.number().int().nonnegative().safe(),
          parent,
        }),
      })
      .optional(),
  })
  .refine((value) => value.operation.decision !== "abandon" || value.rowVersions.length === 0);
export function configurationMaintenanceDbDecisionDigest(
  operation: Omit<ConfigurationMaintenanceDecision, "checkpointDigest">,
  rowVersions: readonly ConfigurationSavedRow[],
): string {
  const { kind: _kind, expectedSequence: _sequence, ...tuple } = operation;
  return createHash("sha256")
    .update("openmapx-configuration-maintenance-db-decision-v1\0")
    .update(canonicalJson({ ...tuple, rowVersions }))
    .digest("hex");
}
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
