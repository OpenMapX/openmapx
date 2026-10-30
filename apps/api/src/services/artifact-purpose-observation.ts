import {
  artifactPublicationResultSchema,
  canonicalJson,
  type OpsOperation,
  stageClaimIdentitySchema,
  transferStageSchema,
} from "@openmapx/core/ops";
import { z } from "zod/v4";
export const purposeObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("artifactTransfer.import"),
    stageId: z.uuid(),
    ownerId: z.string().min(1).max(128),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    identity: stageClaimIdentitySchema,
    publication: artifactPublicationResultSchema,
  }),
  z
    .strictObject({
      kind: z.literal("artifactTransfer.validate"),
      stageId: z.uuid(),
      ownerId: z.string().min(1).max(128),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      identity: stageClaimIdentitySchema,
      stage: transferStageSchema,
    })
    .refine(
      (value) =>
        value.stage.stageId === value.stageId &&
        value.stage.sha256 === value.sha256 &&
        value.stage.purpose === "prepared-artifact" &&
        value.stage.direction === "upload" &&
        ((value.stage.state === "ready" && value.stage.cleanup === "pending") ||
          (value.stage.state === "failed" && value.stage.cleanup === "complete")),
      "A matching final private validation receipt is required",
    ),
]);

export function readArtifactPurposeObservation(
  checkpoint: Record<string, unknown> | null | undefined,
  operation: OpsOperation | undefined,
  identity: {
    executionId: string;
    operationKey: string;
    fingerprint: string;
    executionDeadlineAt: string;
  },
) {
  const saved = purposeObservationSchema.safeParse(checkpoint?._artifactPurposeObservation);
  if (
    !saved.success ||
    !operation ||
    !["artifactTransfer.import", "artifactTransfer.validate"].includes(operation.kind) ||
    !("stageId" in operation) ||
    !("ownerId" in operation) ||
    saved.data.kind !== operation.kind ||
    saved.data.stageId !== operation.stageId ||
    saved.data.ownerId !== operation.ownerId ||
    canonicalJson(saved.data.identity) !== canonicalJson(identity) ||
    (operation.kind === "artifactTransfer.import" && saved.data.sha256 !== operation.expectedSha256)
  )
    return null;
  return saved.data;
}
