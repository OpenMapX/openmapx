import { createHash } from "node:crypto";
import z from "zod/v4";

export const backupReviewDecisionSchema = z.enum([
  "not_applicable",
  "no_material_difference",
  "extract",
  "unavailable",
]);
export const backupReviewReasonSchema = z.enum([
  "outside_retention",
  "post_cutoff",
  "live_snapshot_covers_period",
  "possible_historical_difference",
  "corrupt_or_unverified",
  "unverified_legacy_manifest",
  "unsupported_schema",
  "operator_controlled_elsewhere",
]);
export const backupReviewResultSchema = z
  .object({
    backupId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime({ offset: true }),
    platformVersion: z.string().min(1).max(64),
    decision: backupReviewDecisionSchema,
    reasonCode: backupReviewReasonSchema,
    reviewedBy: z.string().min(1).max(256),
    reviewedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type BackupReviewResult = z.infer<typeof backupReviewResultSchema>;

/** Browser/admin input.  All provenance fields are resolved from the trusted
 * ops-agent inventory and are intentionally not accepted from a caller. */
export const backupReviewRequestSchema = z
  .object({
    backupId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  })
  .strict();
export type BackupReviewRequest = z.infer<typeof backupReviewRequestSchema>;

export interface BackupInventoryVolume {
  serviceId: string;
  volumeId: string;
  mode: "tar" | "pg_dump";
  sizeBytes: number;
  sha256: string | null;
}
export interface BackupInventoryEntry {
  backupId: string;
  manifestDigest: string;
  createdAt: string;
  platformVersion: string;
  formatVersion: 1 | 2;
  volumes: BackupInventoryVolume[];
  expired: boolean;
  verified: boolean;
}

function digestManifest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Convert trusted descriptor metadata into a privacy-safe inventory. Paths,
 * host volume names and secret filenames are intentionally absent. */
export function buildBackupInventory(input: {
  backupId: string;
  manifest: {
    formatVersion?: 1 | 2;
    createdAt: string;
    openmapxVersion: string;
    services: Array<{
      id: string;
      volumes: Array<{ name: string; mode: "tar" | "pg_dump"; sizeBytes: number; sha256?: string }>;
    }>;
  };
  manifestDigest?: string;
  now?: Date;
  retentionDays: number;
}): BackupInventoryEntry {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.backupId))
    throw new Error("Invalid backup identifier");
  const created = Date.parse(input.manifest.createdAt);
  if (!Number.isFinite(created)) throw new Error("Invalid backup creation time");
  if (
    !Number.isSafeInteger(input.retentionDays) ||
    input.retentionDays < 1 ||
    input.retentionDays > 3650
  )
    throw new Error("Invalid backup retention");
  const formatVersion = input.manifest.formatVersion ?? 1;
  const volumes = input.manifest.services.flatMap((service) =>
    service.volumes.map((volume) => ({
      serviceId: service.id,
      volumeId: volume.name,
      mode: volume.mode,
      sizeBytes: volume.sizeBytes,
      sha256: volume.sha256 ?? null,
    })),
  );
  const verified = formatVersion === 2 && volumes.every((volume) => !!volume.sha256);
  const expired = created + input.retentionDays * 86_400_000 <= (input.now ?? new Date()).getTime();
  return {
    backupId: input.backupId,
    manifestDigest: input.manifestDigest ?? digestManifest(input.manifest),
    createdAt: new Date(created).toISOString(),
    platformVersion: input.manifest.openmapxVersion,
    formatVersion,
    volumes,
    expired,
    verified,
  };
}

export function deriveBackupReviewDecision(
  inventory: BackupInventoryEntry,
  input: { cutoffAt: Date; liveSnapshotAt?: Date; now?: Date },
): Pick<BackupReviewResult, "decision" | "reasonCode"> {
  if (inventory.expired) return { decision: "unavailable", reasonCode: "outside_retention" };
  if (!inventory.verified)
    return {
      decision: "unavailable",
      reasonCode:
        inventory.formatVersion === 1 ? "unverified_legacy_manifest" : "corrupt_or_unverified",
    };
  const createdAt = Date.parse(inventory.createdAt);
  if (createdAt > input.cutoffAt.getTime())
    return { decision: "not_applicable", reasonCode: "post_cutoff" };
  if (input.liveSnapshotAt && createdAt <= input.liveSnapshotAt.getTime())
    return { decision: "no_material_difference", reasonCode: "live_snapshot_covers_period" };
  return { decision: "extract", reasonCode: "possible_historical_difference" };
}

export function assertExtractableBackup(
  inventory: BackupInventoryEntry,
  review: BackupReviewResult,
  expected: { backupId: string; manifestDigest: string; cutoffAt: Date },
): void {
  if (review.decision !== "extract" || review.reasonCode !== "possible_historical_difference")
    throw new Error("Backup review does not authorize extraction");
  if (
    inventory.backupId !== expected.backupId ||
    inventory.manifestDigest !== expected.manifestDigest
  )
    throw new Error("Backup inventory changed since review");
  if (!inventory.verified || inventory.expired)
    throw new Error("Backup is not eligible for privacy extraction");
  if (Date.parse(inventory.createdAt) > expected.cutoffAt.getTime())
    throw new Error("Backup is newer than request cutoff");
}
