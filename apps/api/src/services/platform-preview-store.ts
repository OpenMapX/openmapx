/** Original preview rows are immutable; a request retry cannot extend its TTL. */
import { createHash } from "node:crypto";
import { adminPlatformPreviewSchema } from "@openmapx/core/api-contracts";
import {
  type ConfigurationSourcesInspection,
  canonicalJson,
  configurationSourcesInspectionSchema,
} from "@openmapx/core/ops";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthDatabase } from "../account/auth-database";
import { db } from "../db";
import { adminJob, platformConfigurationPreview as table } from "../db/schema";
import { preservationAllowsDeletion, withPreservationRetentionLock } from "../privacy/preservation";
import { noPendingReceiptDelivery, noUnsettledManagedOperation } from "./admin-job-state";

const TTL = 600_000;
const storedPreviewSchema = z.strictObject({
  version: z.literal(1),
  preview: adminPlatformPreviewSchema,
  sourceSnapshot: configurationSourcesInspectionSchema,
  desiredRowVersion: z
    .string()
    .regex(/^\d{1,10}$/)
    .nullable(),
});
export class PlatformPreviewConflict extends Error {
  constructor(message = "Platform preview unavailable or changed") {
    super(message);
  }
}
function decode(row: typeof table.$inferSelect) {
  try {
    const envelope = storedPreviewSchema.safeParse(row.preview);
    const preview = envelope.success
      ? envelope.data.preview
      : adminPlatformPreviewSchema.parse(row.preview);
    if (
      envelope.success &&
      (envelope.data.sourceSnapshot.sourceRevision !== preview.sourceRevision ||
        envelope.data.sourceSnapshot.revisionId !== preview.expectedCurrentRevisionId)
    )
      throw Error();
    const { previewFingerprint, ...intent } = preview;
    const digest = createHash("sha256")
      .update("openmapx-platform-preview-v1\0")
      .update(canonicalJson(intent))
      .digest("hex");
    if (
      digest !== previewFingerprint ||
      previewFingerprint !== row.previewFingerprint ||
      preview.previewId !== row.id ||
      preview.actorId !== row.actorId ||
      preview.authPolicyRevision !== row.authPolicyRevision ||
      preview.sourceRevision !== row.sourceRevision ||
      preview.expectedCurrentRevisionId !== row.expectedCurrentRevisionId ||
      row.expiresAt.getTime() !== row.createdAt.getTime() + TTL
    )
      throw Error();
    return {
      preview,
      sourceSnapshot: envelope.success ? envelope.data.sourceSnapshot : undefined,
      desiredRowVersion: envelope.success ? envelope.data.desiredRowVersion : undefined,
      expiresAt: row.expiresAt.toISOString(),
      consumedByJobId: row.consumedByJobId,
    };
  } catch {
    throw new PlatformPreviewConflict();
  }
}
/** Caller holds the shared preservation-retention lock. Unknown/running work
 * is pinned; a completed preview and its exact job share the later 72h floor. */
export async function prunePlatformConfigurationPreviews(
  connection: Pick<typeof db, "delete">,
  now = new Date(),
): Promise<number> {
  const rows = connection
    .delete(table)
    .where(
      and(
        or(
          and(isNull(table.consumedByJobId), lt(table.expiresAt, now)),
          and(
            isNotNull(table.retiredAt),
            sql`exists (
            select 1 from ${adminJob}
            where ${adminJob.id} = ${table.consumedByJobId}::text
              and ${adminJob.status} in ('success','failed','canceled')
              and ${adminJob.finishedAt} is not null
              and greatest(${table.retiredAt},${adminJob.finishedAt}) < ${new Date(now.getTime() - 72 * 3600000).toISOString()}::timestamptz
              and ${noPendingReceiptDelivery()}
              and ${noUnsettledManagedOperation()}
          )`,
          ),
        ),
        preservationAllowsDeletion({
          registrationId: "platform-configuration-previews",
          candidateTimestamp: table.createdAt,
          subjectIds: [table.actorId],
        }),
      ),
    )
    .returning({ id: table.id });
  return (await rows).length;
}

export async function retainPlatformPreview(
  input: {
    actorId: string;
    operationKey: string;
    requestFingerprint: string;
    preview: unknown;
    sourceSnapshot?: ConfigurationSourcesInspection;
    desiredRowVersion?: string | null;
    now?: Date;
  },
  database: typeof db = db,
) {
  const preview = adminPlatformPreviewSchema.parse(input.preview),
    now = input.now ?? new Date();
  z.string().min(1).max(128).parse(input.operationKey);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.requestFingerprint);
  if (preview.actorId !== input.actorId) throw new PlatformPreviewConflict();
  return withPreservationRetentionLock(database, async (tx) => {
    // One capacity/expiry boundary also serializes all duplicate request keys.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('openmapx.platform.preview',71956))`,
    );
    const [existing] = await tx
      .select()
      .from(table)
      .where(and(eq(table.actorId, input.actorId), eq(table.operationKey, input.operationKey)))
      .for("update");
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint)
        throw new PlatformPreviewConflict("Platform preview request changed");
      if (existing.expiresAt <= now)
        throw new PlatformPreviewConflict("Platform preview expired; create a new preview");
      return decode(existing);
    }
    await prunePlatformConfigurationPreviews(tx, now);
    const capacity = await tx.select({ id: table.id }).from(table).limit(4096);
    if (capacity.length >= 4096)
      throw new PlatformPreviewConflict("Platform preview capacity unavailable");
    const stored = input.sourceSnapshot
      ? storedPreviewSchema.parse({
          version: 1,
          preview,
          sourceSnapshot: input.sourceSnapshot,
          desiredRowVersion: input.desiredRowVersion,
        })
      : preview;
    if (
      input.sourceSnapshot &&
      (input.sourceSnapshot.sourceRevision !== preview.sourceRevision ||
        input.sourceSnapshot.revisionId !== preview.expectedCurrentRevisionId)
    )
      throw new PlatformPreviewConflict();
    const [size] = await tx.execute<{ bytes: number }>(
      sql`select octet_length(${JSON.stringify(stored)}::jsonb::text) as bytes`,
    );
    if (!size || size.bytes > 131072)
      throw new PlatformPreviewConflict("Platform preview capacity unavailable");
    const [row] = await tx
      .insert(table)
      .values({
        id: preview.previewId,
        actorId: input.actorId,
        operationKey: input.operationKey,
        requestFingerprint: input.requestFingerprint,
        previewFingerprint: preview.previewFingerprint,
        authPolicyRevision: preview.authPolicyRevision,
        sourceRevision: preview.sourceRevision,
        expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
        preview: stored,
        createdAt: now,
        expiresAt: new Date(now.getTime() + TTL),
      })
      .returning();
    if (!row) throw new PlatformPreviewConflict();
    return decode(row);
  });
}
export async function readPlatformPreview(
  input: { actorId: string; previewFingerprint: string; now?: Date },
  database: AuthDatabase = db,
) {
  const [row] = await database
    .select()
    .from(table)
    .where(
      and(eq(table.actorId, input.actorId), eq(table.previewFingerprint, input.previewFingerprint)),
    )
    .limit(1);
  if (!row) throw new PlatformPreviewConflict();
  if (row.expiresAt <= (input.now ?? new Date()))
    throw new PlatformPreviewConflict("Platform preview expired; create a new preview");
  return decode(row);
}
