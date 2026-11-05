/** Bounded copied observation, never a target owner/grant or final evidence. */
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { executionRefSchema } from "../ops/execution-ref";
import { ownedServiceSnapshotSchema } from "../ops/owned-service-records";
import { servicePullResultSchema } from "../ops/service-operation-records";
export const coordinatorPullObservationDomain = "openmapx-coordinator-pull-observation-v2";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const coordinatorPullBaselineSchema = z
  .strictObject({
    version: z.literal(1),
    candidateId: z.uuid(),
    sourceRevision: z.uuid(),
    configurationRevisionId: servicePullResultSchema.shape.revisionId,
    configurationAuthorityRevision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    policyRevision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    submissionDigest: digest,
    observedAt: z.number().int().nonnegative().safe(),
    configImageReference: servicePullResultSchema.shape.imageReference,
    composeSourcesDigest: digest,
    container: ownedServiceSnapshotSchema.refine(
      (v) => v.serviceId === "data-manager" && v.state === "running",
    ),
  })
  .refine((v) => Buffer.byteLength(canonicalJson(v)) <= 3072);
export type CoordinatorPullBaseline = z.infer<typeof coordinatorPullBaselineSchema>;
export const coordinatorPullWitnessPayloadSchema = z.strictObject({
  version: z.literal(2),
  installationId: z.uuid(),
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  maintenancePrepare: executionRefSchema,
  pull: executionRefSchema,
  submissionDigest: digest,
  operationFingerprint: digest,
  apiParentDigest: digest,
  sourceRevision: z.uuid(),
  revisionId: servicePullResultSchema.shape.revisionId,
  imageReference: servicePullResultSchema.shape.imageReference,
  imageId: servicePullResultSchema.shape.imageId,
  releaseSelectionDigest: servicePullResultSchema.shape.releaseSelectionDigest,
  terminalReceiptDigest: digest,
  effectReceiptDigest: digest,
  baseline: coordinatorPullBaselineSchema,
  baselineAdmissionDigest: digest,
  verifiedAt: z.number().int().nonnegative().safe(),
});
export const coordinatorPullWitnessSchema = z
  .strictObject({
    payload: coordinatorPullWitnessPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .refine((v) => Buffer.byteLength(canonicalJson(v)) <= 8192);
export type CoordinatorPullWitness = z.infer<typeof coordinatorPullWitnessSchema>;

/** Historical source facts, distinct from a new owner's pull witness. */
export const stagedCoordinatorSourceSchema = z.strictObject({
  execution: executionRefSchema,
  admittedAt: z.number().int().nonnegative().safe(),
  baseline: coordinatorPullBaselineSchema,
  admissionDigest: digest,
  canonicalDigest: digest,
  effectDigest: digest,
  apiCopyDigest: digest,
});
export const stagedCoordinatorObservationDomain =
  "openmapx-maintenance-staged-coordinator-observation-v1";
export const stagedCoordinatorObservationPayloadSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  ownerPrepare: executionRefSchema,
  candidateId: z.uuid(),
  planDigest: digest,
  source: stagedCoordinatorSourceSchema,
  capturedAt: z.number().int().nonnegative().safe(),
});
export const stagedCoordinatorObservationSchema = z
  .strictObject({
    payload: stagedCoordinatorObservationPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .refine((value) => Buffer.byteLength(canonicalJson(value)) <= 8192);
export type StagedCoordinatorObservation = z.infer<typeof stagedCoordinatorObservationSchema>;

/** Collector-owned runtime token; no structural phase flag is authority. */
declare const retentionPreparationBrand: unique symbol;
export type ControlRetentionPreparationContext = Readonly<{ [retentionPreparationBrand]: true }>;
export const stagedCoordinatorRetirementDomain = "openmapx-staged-coordinator-retirement-v1";
export const stagedCoordinatorRankSchema = z.strictObject({
  admittedAt: z.number().int().nonnegative().safe(),
  operationKey: executionRefSchema.shape.operationKey,
});
export const stagedCoordinatorRetirementPayloadSchema = z
  .strictObject({
    version: z.literal(1),
    installationId: z.uuid(),
    originDigest: digest,
    familyId: z.uuid(),
    generation: z.uuid(),
    execution: executionRefSchema,
    terminalDigest: digest,
    sourceAdmissionDigest: digest,
    oldContainerDigest: digest,
    rank: stagedCoordinatorRankSchema,
    contextMode: z.enum(["preparing", "before-commit", "committed-cleanup"]),
    checkNonce: z.uuid(),
    manifestDigest: digest.nullable(),
    checkedAt: z.number().int().nonnegative().safe(),
    condition: z.enum(["not-needed", "higher-ranked-successor"]),
    successor: z
      .strictObject({
        execution: executionRefSchema,
        admissionDigest: digest,
        canonicalDigest: digest,
        effectDigest: digest,
        apiCopyDigest: digest,
        rank: stagedCoordinatorRankSchema,
      })
      .nullable(),
  })
  .refine((value) => (value.condition === "not-needed") === (value.successor === null));
export const stagedCoordinatorRetirementPacketSchema = z
  .strictObject({
    payload: stagedCoordinatorRetirementPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .refine((value) => Buffer.byteLength(canonicalJson(value)) <= 4096);
export type StagedCoordinatorRetirementPacket = z.infer<
  typeof stagedCoordinatorRetirementPacketSchema
>;
