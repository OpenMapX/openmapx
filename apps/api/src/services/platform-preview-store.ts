/** Original preview rows are immutable; a request retry cannot extend its TTL. */
import { createHash } from "node:crypto";
import { adminPlatformPreviewSchema } from "@openmapx/core/api-contracts";
import { canonicalJson } from "@openmapx/core/ops";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthDatabase } from "../account/auth-database";
import { db } from "../db";
import { platformConfigurationPreview as table } from "../db/schema";
import { preservationAllowsDeletion, withPreservationRetentionLock } from "../privacy/preservation";

const TTL = 600_000;
export class PlatformPreviewConflict extends Error {
  constructor(message = "Platform preview unavailable or changed") {
    super(message);
  }
}
function decode(row: typeof table.$inferSelect) {
  try {
    const preview = adminPlatformPreviewSchema.parse(row.preview);
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
      expiresAt: row.expiresAt.toISOString(),
      consumedByJobId: row.consumedByJobId,
    };
  } catch {
    throw new PlatformPreviewConflict();
  }
}
export async function retainPlatformPreview(
  input: {
    actorId: string;
    operationKey: string;
    requestFingerprint: string;
    preview: unknown;
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
    // Unconsumed previews never authorized effects; consumed/unknown work stays pinned.
    await tx.delete(table).where(
      and(
        isNull(table.consumedByJobId),
        lt(table.expiresAt, now),
        preservationAllowsDeletion({
          registrationId: "admin-jobs-attribution",
          candidateTimestamp: table.createdAt,
          subjectIds: [table.actorId],
        }),
      ),
    );
    const capacity = await tx.select({ id: table.id }).from(table).limit(4096);
    if (capacity.length >= 4096)
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
        preview,
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
