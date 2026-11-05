import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import z from "zod/v4";

const TiB = 1024 ** 4;
const integer = (max: number) => z.number().int().positive().safe().max(max);
export const artifactTransferPolicySchema = z
  .strictObject({
    maxUploadBytes: integer(8 * TiB).default(TiB),
    maxExpandedBytes: integer(16 * TiB).default(2 * TiB),
    maxStageBytes: integer(32 * TiB).default(4 * TiB),
    maxEntryBytes: integer(16 * TiB).default(2 * TiB),
    maxEntries: integer(1_000_000).default(250_000),
    maxManifestBytes: integer(256 * 1024 ** 2).default(64 * 1024 ** 2),
    maxPathBytes: integer(4096).default(4096),
    maxPathDepth: integer(64).default(64),
    maxExtendedHeaderBytes: integer(16384).default(16384),
    maxExpansionRatio: integer(1000).default(1000),
    expansionRatioThresholdBytes: integer(64 * 1024 ** 2).default(64 * 1024 ** 2),
    maxConcurrentArchiveJobs: integer(4).default(1),
    maxConcurrentTransfers: integer(4).default(2),
    maxConcurrentTransfersPerPrincipal: integer(4).default(1),
    maxRetainedStagesPerPrincipal: integer(100).default(4),
    idleMs: integer(5 * 60_000).default(5 * 60_000),
    transferMs: integer(7 * 86400_000).default(72 * 3600_000),
    stageMs: integer(8 * 86400_000).default(96 * 3600_000),
    downloadRetentionMs: integer(24 * 3600_000).default(24 * 3600_000),
    memoryBudgetBytes: integer(16 * 1024 ** 3).default(1024 ** 3),
  })
  .refine(
    (p) =>
      p.maxEntryBytes <= p.maxExpandedBytes &&
      p.maxUploadBytes <= p.maxStageBytes &&
      p.stageMs > p.transferMs &&
      p.maxConcurrentTransfersPerPrincipal <= p.maxConcurrentTransfers &&
      p.maxConcurrentArchiveJobs <= p.maxConcurrentTransfers,
  )
  .refine(
    (p) =>
      p.memoryBudgetBytes >=
      p.maxManifestBytes * 4 + p.maxEntries * 2048 + p.maxConcurrentTransfers * 8 * 1024 ** 2,
    "Transfer metadata exceeds declared memory budget",
  );
export type ArtifactTransferPolicy = z.infer<typeof artifactTransferPolicySchema>;
export const DEFAULT_TRANSFER_POLICY = artifactTransferPolicySchema.parse({});
export function transferPolicyRevision(policy: ArtifactTransferPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}
function availableMemoryBytes(): number {
  const constrained = process.constrainedMemory?.() ?? 0;
  return constrained > 0 ? constrained : Infinity;
}
function checkedPolicy(
  policy: ArtifactTransferPolicy,
): { policy: ArtifactTransferPolicy; revision: string } | { reason: string } {
  if (policy.memoryBudgetBytes > availableMemoryBytes())
    return {
      reason:
        "Artifact transfer policy exceeds the agent memory allocation; lower limits or raise the container memory allocation",
    };
  return { policy, revision: transferPolicyRevision(policy) };
}
export function loadArtifactTransferPolicy(
  path = process.env.OPENMAPX_ARTIFACT_TRANSFER_POLICY_FILE ??
    "/run/openmapx/artifact-transfer-policy.json",
): { policy: ArtifactTransferPolicy; revision: string } | { reason: string } {
  try {
    const parsed = z
      .strictObject({ artifactTransfer: artifactTransferPolicySchema })
      .parse(JSON.parse(readFileSync(path, "utf8")));
    return checkedPolicy(parsed.artifactTransfer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return checkedPolicy(DEFAULT_TRANSFER_POLICY);
    return {
      reason:
        "Invalid artifact transfer policy; correct the deployment policy and restart the operations agent",
    };
  }
}
export function purposeByteLimit(policy: ArtifactTransferPolicy, purpose: string): number {
  return Math.min(
    policy.maxUploadBytes,
    purpose === "integration-artifact"
      ? 200 * 1024 ** 2
      : purpose === "instance-migration"
        ? 64 * 1024 ** 2
        : policy.maxUploadBytes,
  );
}
