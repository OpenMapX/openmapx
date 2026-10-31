import z from "zod/v4";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  count = z.number().int().nonnegative().safe();
export const backupPruneProofSchema = z.strictObject({
  inventoryDigest: digest,
  policyRevision: digest,
  previewedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  authenticator: digest,
});
export const backupPrunePreviewSchema = z.strictObject({
  proof: backupPruneProofSchema,
  cutoff: z.iso.datetime(),
  retentionDays: z.number().int().min(1).max(36500),
  policySource: z.enum(["host", "database"]),
  candidates: z
    .array(
      z.strictObject({
        backupId: id,
        createdAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        totalBytes: count,
        corrupt: z.boolean(),
      }),
    )
    .max(128),
  retainedCount: count,
  corruptBackups: z.array(id).max(128),
});
export const backupPruneResultSchema = z.strictObject({
  deleted: z.array(id).max(128),
  retainedCount: count,
  inventoryDigest: digest,
});
export type BackupPruneProof = z.infer<typeof backupPruneProofSchema>;
