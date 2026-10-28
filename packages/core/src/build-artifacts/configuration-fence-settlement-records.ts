/** Strict server-private records for the approved fixed-reference protocol.
 * Parsing any of these records creates data, never execution/inspection authority. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { executionRefSchema } from "../ops/execution-ref";
import {
  dataConfigurationFenceReceiptSchema,
  dataConfigurationFenceSettleSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import { controlChildReservationSchema } from "./control-child-records";
import { controlOriginSchema } from "./control-records";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  epoch = z.number().int().nonnegative().safe();
const id = z.uuid(),
  ordinal = z.number().int().min(0).max(255),
  service = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const uniqueSorted = <T extends z.ZodType<string>>(schema: T, max: number) =>
  z
    .array(schema)
    .max(max)
    .refine((items) => items.every((item, i) => i === 0 || items[i - 1]! < item));
const digests = uniqueSorted(digest, 64),
  serviceIds = uniqueSorted(service, 256).min(1);
const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
export const configurationSettlementDomains = Object.freeze({
  reference: "openmapx-configuration-fence-settlement-v2",
  preparedReceipt: "openmapx-configuration-prepared-receipt-v2",
  finalEvidence: "openmapx-configuration-final-evidence-v2",
  ownerFinal: "openmapx-configuration-owner-final-v2",
  commitment: "openmapx-configuration-settlement-commitment-v2",
  inspection: "openmapx-configuration-runtime-inspection-v2",
  reservationTuple: "openmapx-configuration-settlement-reservation-tuple-v2",
  projection: "openmapx-configuration-settlement-reservation-projection-v2",
  signedProjection: "openmapx-configuration-settlement-reservation-v2",
  control: "openmapx-configuration-fence-control-v3",
  binding: "openmapx-configuration-settlement-control-v3",
  assertion: "openmapx-configuration-fence-control-assertion-v2",
  capacity: "openmapx-configuration-settlement-capacity-v2",
  admission: "openmapx-configuration-settlement-admission-v2",
  effect: "openmapx-configuration-settlement-effect-v2",
  dispatch: "openmapx-configuration-settlement-dispatch-v2",
  terminal: "openmapx-dm-configuration-settlement-terminal-v2",
  ack: "openmapx-configuration-settlement-ack-v2",
  refusal: "openmapx-dm-configuration-no-guard-refusal-v2",
  unusedIntent: "openmapx-configuration-unused-capacity-intent-v2",
  unusedConfirmation: "openmapx-configuration-unused-capacity-confirmation-v2",
  neverIssued: "openmapx-configuration-never-issued-v2",
  issuedRefused: "openmapx-configuration-issued-prepare-refused-v2",
  closure: "openmapx-configuration-no-guard-closure-v2",
  bundle: "openmapx-configuration-no-guard-bundle-v2",
});
export const settlementRecordDigest = (
  domain: (typeof configurationSettlementDomains)[keyof typeof configurationSettlementDomains],
  value: unknown,
) =>
  createHash("sha256")
    .update(`${domain}\0${canonicalJson(value)}`)
    .digest("hex");
const signed = <T extends z.ZodType>(payload: T) =>
  z.strictObject({ payload, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export const configurationSettlementOwnerIdentitySchema = z
  .strictObject({
    installationId: id,
    origin: controlOriginSchema,
    ownerPrepare: executionRefSchema,
    admissionDigest: digest,
    rootCertificateDigest: digest,
    maintenanceId: id,
    candidateId: id,
    planDigest: digest,
    settlementId: digest,
  })
  .refine(
    (value) =>
      value.origin.issuer === "ops-agent" &&
      value.ownerPrepare.executor === "ops-agent" &&
      value.ownerPrepare.principal === "api" &&
      value.ownerPrepare.deadlineAt <= value.origin.notAfter,
  );
export type ConfigurationSettlementOwnerIdentity = z.infer<
  typeof configurationSettlementOwnerIdentitySchema
>;
export function deriveConfigurationFenceSettlementId(
  input: Pick<
    ConfigurationSettlementOwnerIdentity,
    "installationId" | "ownerPrepare" | "maintenanceId" | "candidateId" | "planDigest"
  >,
): string {
  id.parse(input.installationId);
  executionRefSchema.parse(input.ownerPrepare);
  id.parse(input.maintenanceId);
  id.parse(input.candidateId);
  digest.parse(input.planDigest);
  return createHash("sha256")
    .update(
      `${configurationSettlementDomains.reference}\0${input.installationId}\0${input.ownerPrepare.operationKey}\0${input.maintenanceId}\0${input.candidateId}\0${input.planDigest}`,
    )
    .digest("hex");
}
export const configurationPreparedGuardSchema = z.strictObject({
  fenceId: id,
  preparedReceipt: dataConfigurationFenceReceiptSchema.refine(
    (receipt) => receipt.state === "prepared",
  ),
  preparedReceiptDigest: digest,
  preparedCanonicalDigest: digest,
  preparedTerminalAt: epoch,
});
export const configurationDecisionEvidenceSchema = z.strictObject({
  decisionId: id,
  decision: z.enum(["continue", "abandon"]),
  checkpointVersion: epoch,
  checkpointDigest: digest,
  apiParentAttestationDigest: digest,
});
export const configurationChildEvidenceSchema = z.strictObject({
  planIndex: z.number().int().min(0).max(31),
  execution: executionRefSchema,
  terminalDigest: digest,
  terminalAt: epoch,
  effectSettlementDigest: digest,
  publication: z.enum(["not_started", "committed"]),
});
const childProjection = configurationChildEvidenceSchema
  .omit({ execution: true })
  .extend({ executionDigest: digest });
const generation = z
  .strictObject({
    state: z.enum(["not_committed", "committed"]),
    revisionId: revision.nullable(),
    commitReceiptDigest: digest.nullable(),
  })
  .refine((value) =>
    value.state === "committed"
      ? value.revisionId !== null && value.commitReceiptDigest !== null
      : value.revisionId === null && value.commitReceiptDigest === null,
  );
const followUp = z.strictObject({
  state: z.enum(["not_started", "complete", "contained"]),
  receiptDigests: digests,
});
const runtime = z.strictObject({
  verificationId: id,
  mode: z.enum(["unused", "applied", "contained"]),
  requiredCheckSetDigest: digest,
  checkedAt: epoch,
});
const finalFields = {
  identity: configurationSettlementOwnerIdentitySchema,
  guard: configurationPreparedGuardSchema,
  decision: configurationDecisionEvidenceSchema,
  generation,
  followUp,
  runtime,
  outcome: z.enum(["unused", "applied", "contained"]),
};
function eligible(value: z.infer<z.ZodObject<typeof finalFields>>) {
  return (
    value.runtime.mode === value.outcome &&
    (value.outcome === "unused"
      ? value.decision.decision === "abandon" &&
        value.generation.state === "not_committed" &&
        value.followUp.state === "not_started"
      : value.decision.decision === "continue" &&
        (value.outcome !== "applied" ||
          (value.generation.state === "committed" &&
            value.generation.revisionId === value.guard.preparedReceipt.revisionId &&
            value.followUp.state === "complete")))
  );
}
export const configurationFinalEvidenceSchema = z
  .strictObject({ ...finalFields, children: z.array(configurationChildEvidenceSchema).max(64) })
  .refine(eligible);
export const configurationFinalEvidenceProjectionSchema = z
  .strictObject({ ...finalFields, children: z.array(childProjection).max(64) })
  .refine(eligible);
export const configurationOwnerFinalSchema = z.strictObject({
  version: z.literal(2),
  identity: configurationSettlementOwnerIdentitySchema,
  ownerSequence: epoch,
  settlingAt: epoch,
  expectedDmSequence: epoch,
  evidenceDigest: digest,
  outcome: z.enum(["unused", "applied", "contained"]),
  privateInspectionId: id,
});
export const configurationCommittedSettlementSchema = z.strictObject({
  version: z.literal(2),
  phase: z.literal("committed"),
  identity: configurationSettlementOwnerIdentitySchema,
  referenceOperationFingerprint: digest,
  final: configurationOwnerFinalSchema,
  evidence: configurationFinalEvidenceProjectionSchema,
  evidenceDigest: digest,
  ownerReceiptDigest: digest,
  committedAt: epoch,
});
export const fixedConfigurationFenceSettleOperationSchema =
  dataConfigurationFenceSettleSchema.extend({
    kind: z.literal("configuration-maintenance.settle"),
  });
export const configurationSettlementReservationProjectionSchema = z.strictObject({
  version: z.literal(2),
  purpose: z.literal("configuration-fence-settlement-reservation"),
  installationId: id,
  origin: controlOriginSchema,
  ownerPrepare: executionRefSchema,
  rootAdmissionDigest: digest,
  rootCertificateDigest: digest,
  maintenanceId: id,
  candidateId: id,
  planDigest: digest,
  settlementId: digest,
  reservation: z
    .lazy(() => controlChildReservationSchema)
    .refine(
      (value) =>
        value.phase === "configuration-fence-settle" &&
        value.kind === "configuration-maintenance.settle" &&
        value.recipient === "data-manager" &&
        value.execution.executor === "data-manager" &&
        value.execution.principal === "api",
    ),
  operation: fixedConfigurationFenceSettleOperationSchema,
  reservationDigest: digest,
  issuerMembership: z.strictObject({
    role: z.literal("ops-agent"),
    familyId: id,
    rootMemberOrdinal: ordinal,
    rootExecutionDigest: digest,
    rootAdmissionDigest: digest,
  }),
});
export const signedConfigurationReservationProjectionSchema = signed(
  configurationSettlementReservationProjectionSchema,
);
const address = z
  .strictObject({
    executor: executionRefSchema.shape.executor,
    principal: executionRefSchema.shape.principal,
    executionId: executionRefSchema.shape.executionId,
    operationKey: executionRefSchema.shape.operationKey,
  })
  .refine(
    (value) =>
      value.executor === "data-manager" &&
      value.principal === "api" &&
      id.safeParse(value.executionId).success,
  );
const descriptor = z.strictObject({
  scope: z.enum(["private", "shared"]),
  namespace: z.enum(["observations", "execution"]),
  role: z.enum(["ops-agent", "data-manager"]),
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_.-]+$/),
  cap: z.number().int().positive().max(16384),
});
export const configurationSettlementCapacitySchema = z.strictObject({
  version: z.literal(2),
  installationId: id,
  origin: controlOriginSchema,
  ownerPrepareDigest: digest,
  settlementId: digest,
  proposedExecutionAddress: address,
  reservedExecutionOrdinal: ordinal,
  reservedIntentOrdinal: ordinal,
  recordDescriptorsDigest: digest,
  maxBytes: z.number().int().positive().max(65536),
  projectionDigest: digest,
  reservationDigest: digest,
});
export const signedConfigurationSettlementCapacitySchema = signed(
  configurationSettlementCapacitySchema,
);
export const configurationSettlementControlEnvelopeSchema = z
  .strictObject({
    version: z.literal(2),
    bindingVersion: z.literal(3),
    purpose: z.literal("configuration-fence-settlement"),
    installationId: id,
    origin: controlOriginSchema,
    ownerPrepare: executionRefSchema,
    admissionDigest: digest,
    rootCertificateDigest: digest,
    settlementId: digest,
    projectionDigest: digest,
    reservationDigest: digest,
    commitmentDigest: digest,
    execution: executionRefSchema,
    operation: fixedConfigurationFenceSettleOperationSchema,
    serviceIds,
    controlStartedAt: epoch,
    controlDeadlineAt: epoch,
    originalParentForwardDeadlineAt: epoch,
    dispatchId: id,
  })
  .refine(
    (value) =>
      value.controlDeadlineAt === value.controlStartedAt + 60000 &&
      value.execution.deadlineAt === value.controlDeadlineAt &&
      value.originalParentForwardDeadlineAt === value.ownerPrepare.deadlineAt &&
      value.execution.executor === "data-manager" &&
      value.execution.principal === value.ownerPrepare.principal &&
      value.ownerPrepare.principal === "api",
  );
export const configurationSettlementSqlSessionSchema = z.strictObject({
  pid: z.number().int().min(1).max(2147483647),
  backendStart: z.string().min(1).max(64),
  sessionNonce: id,
});
/** A disjoint purpose assertion, never an ordinary parent/delegation token.
 * Its envelope digest binds the whole fixed body/execution/installation. */
export const configurationSettlementAssertionSchema = z.strictObject({
  version: z.literal(2),
  purpose: z.literal("configuration-fence-settlement"),
  settlementId: digest,
  controlEnvelopeDigest: digest,
});
export const configurationSettlementTerminalTupleSchema = z.strictObject({
  execution: executionRefSchema,
  settlementId: digest,
  commitmentDigest: digest,
  fenceId: id,
  result: dataConfigurationFenceReceiptSchema.refine((receipt) => receipt.state === "settled"),
  publication: z.literal("committed"),
  terminalAt: epoch,
  terminalDigest: digest,
});
export const configurationSettlementSqlControlSchema = z.strictObject({
  version: z.literal(2),
  settlementId: digest,
  controlEnvelopeDigest: digest,
  commitmentDigest: digest,
  admissionDigest: digest,
  outcome: z.enum(["unused", "applied", "contained"]),
  expectedDmSequence: epoch,
  preparedReceiptDigest: digest,
  attemptedAt: epoch,
  sqlSession: configurationSettlementSqlSessionSchema,
  tuple: configurationSettlementTerminalTupleSchema,
});
export const configurationSettlementContainedObservationSchema = z.strictObject({
  version: z.literal(2),
  state: z.literal("contained_not_settled"),
  settlementId: digest,
  controlExecutionDigest: digest,
  controlEnvelopeDigest: digest,
  commitmentDigest: digest,
  preparedReceiptDigest: digest,
  expectedDmSequence: epoch,
  attemptedAt: epoch,
  observationAt: epoch,
  sqlSession: configurationSettlementSqlSessionSchema,
  containment: z.enum(["explicit_rollback", "original_session_absent"]),
});
export const configurationSettlementAckSchema = z.strictObject({
  version: z.literal(2),
  installationId: id,
  origin: controlOriginSchema,
  settlementId: digest,
  controlExecutionDigest: digest,
  terminalDigest: digest,
  terminalAt: epoch,
  commitmentDigest: digest,
});
export const configurationSettlementDispatchSchema = z.strictObject({
  version: z.literal(2),
  origin: controlOriginSchema,
  settlementId: digest,
  phase: z.enum(["prepared", "attempted"]),
  dispatchId: id,
  controlEnvelopeDigest: digest,
  controlExecutionDigest: digest,
  commitmentDigest: digest,
  attemptedAt: epoch.nullable(),
});
export const configurationSettlementAdmissionSchema = z.strictObject({
  version: z.literal(2),
  purpose: z.literal("configuration-fence-settlement"),
  installationId: id,
  origin: controlOriginSchema,
  settlementId: digest,
  projectionDigest: digest,
  reservationDigest: digest,
  prepareExecutionDigest: digest,
  prepareAdmissionDigest: digest,
  preparedReceiptDigest: digest,
  capacityReceiptDigest: digest,
  rootCertificateDigest: digest,
  controlEnvelope: signed(configurationSettlementControlEnvelopeSchema),
  commitmentDigest: digest,
  executionOrdinal: ordinal,
  intentOrdinal: ordinal,
  sqlSessionNonce: id,
  boundAt: epoch,
});
export const configurationSettlementEffectSchema = z
  .strictObject({
    version: z.literal(2),
    origin: controlOriginSchema,
    settlementId: digest,
    controlExecutionDigest: digest,
    controlEnvelopeDigest: digest,
    admissionDigest: digest,
    commitmentDigest: digest,
    preparedReceiptDigest: digest,
    expectedDmSequence: epoch,
    attemptedAt: epoch,
    sqlSession: configurationSettlementSqlSessionSchema,
    phase: z.enum(["attempted", "committed", "unknown", "contained_not_settled"]),
    terminal: configurationSettlementTerminalTupleSchema.nullable(),
    observation: configurationSettlementContainedObservationSchema.nullable(),
  })
  .refine((value) =>
    value.phase === "committed"
      ? value.terminal !== null && value.observation === null
      : value.phase === "contained_not_settled"
        ? value.terminal === null && value.observation !== null
        : value.terminal === null && value.observation === null,
  );
const { terminal: _effectTerminal, ...effectSourceFields } =
  configurationSettlementEffectSchema.shape;
/** Preserve the original FULL signed effect preimage without encoding the
 * same tuple twice: reconstruct { ...fields, terminal: tuple } and verify its
 * original signature/domain. This is data, not a general effect capability. */
export const configurationSettlementEffectSourceSchema = z.strictObject({
  fields: z.strictObject(effectSourceFields),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export const configurationSettlementPublishedTerminalSchema = z.strictObject({
  version: z.literal(2),
  origin: controlOriginSchema,
  admissionDigest: digest,
  tuple: configurationSettlementTerminalTupleSchema,
  effectSettlementDigest: digest,
  effectSource: configurationSettlementEffectSourceSchema,
  // All other original admission fields are fixed by the authenticated
  // projection/capacity/envelope/preparation already retained by both roles.
  admissionSource: z.strictObject({
    boundAt: epoch,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }),
});
export const configurationSettlementSenderAckCellSchema = z.strictObject({
  version: z.literal(2),
  terminal: signed(configurationSettlementPublishedTerminalSchema),
  ack: signed(configurationSettlementAckSchema).nullable(),
});
export const configurationDmNoGuardRefusalSchema = z.strictObject({
  version: z.literal(2),
  installationId: id,
  origin: controlOriginSchema,
  ownerPrepare: executionRefSchema,
  rootAdmissionDigest: digest,
  rootCertificateDigest: digest,
  maintenanceId: id,
  candidateId: id,
  planDigest: digest,
  settlementId: digest,
  projectionDigest: digest,
  reservationDigest: digest,
  prepareExecution: executionRefSchema,
  prepareAdmissionDigest: digest,
  refusalReceipt: z.strictObject({
    kind: z.literal("data-configuration-fence-refused"),
    maintenanceId: id,
    reason: z.enum(["busy", "capacity"]),
  }),
  effectReceiptDigest: digest,
  effectSettlementDigest: digest,
  canonicalTerminalDigest: digest,
  canonicalTerminalAt: epoch,
  capacityReceiptDigest: digest.nullable(),
});
export const configurationUnusedCapacityIntentSchema = z.strictObject({
  version: z.literal(2),
  installationId: id,
  origin: controlOriginSchema,
  role: z.enum(["ops-agent", "data-manager"]),
  ownerPrepareDigest: digest,
  prepareExecutionDigest: digest.nullable(),
  settlementId: digest,
  projectionDigest: digest,
  capacityReceiptDigest: digest.nullable(),
  sourceProofDigest: digest,
  executionOrdinal: ordinal.nullable(),
  intentOrdinal: ordinal.nullable(),
  recordDescriptorsDigest: digest,
  allocatedDescriptorDigests: uniqueSorted(digest, 12),
  createdAt: epoch,
});
export const configurationUnusedCapacityConfirmationSchema = z.strictObject({
  version: z.literal(2),
  installationId: id,
  origin: controlOriginSchema,
  role: z.enum(["ops-agent", "data-manager"]),
  ownerPrepareDigest: digest,
  settlementId: digest,
  projectionDigest: digest,
  intentDigest: digest,
  slotStateDigest: digest,
  confirmedAt: epoch,
});
const publication = z.strictObject({
  phase: z.string().min(1).max(64),
  ordinal: z.number().int().min(0).max(63),
  operationKey: executionRefSchema.shape.operationKey,
  grantState: z.literal("unissued"),
  intentState: z.literal("not_attempted"),
});
export const configurationNeverIssuedProofSchema = z.strictObject({
  version: z.literal(2),
  identity: configurationSettlementOwnerIdentitySchema,
  issuerSequence: epoch,
  frozenAt: epoch,
  prepareReservationDigest: digest,
  publicationStates: z.array(publication).max(64),
});
export const configurationIssuedPrepareRefusedProofSchema = z.strictObject({
  version: z.literal(2),
  kind: z.literal("issued_preparation_refused"),
  identity: configurationSettlementOwnerIdentitySchema,
  issuerSequence: epoch,
  frozenAt: epoch,
  prepareGrantDigest: digest,
  prepareExecutionDigest: digest,
  refusalProjectionDigest: digest,
  remainingPublicationStates: z.array(publication).max(64),
  candidateClaimState: z.literal("not_consumed"),
});
export const configurationNoGuardEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("never_issued"),
    issuerFreezeProofDigest: digest,
    prepareReservationDigest: digest,
    publicationStatesDigest: digest,
    issuerSequence: epoch,
    frozenAt: epoch,
  }),
  z.strictObject({
    kind: z.literal("receiver_refused"),
    issuerFreezeProofDigest: digest,
    prepareExecutionDigest: digest,
    prepareAdmissionDigest: digest,
    refusalProjectionDigest: digest,
    effectSettlementDigest: digest,
    canonicalTerminalDigest: digest,
    canonicalTerminalAt: epoch,
    dmUnusedIntentDigest: digest,
    dmUnusedConfirmationDigest: digest,
    capacityReceiptDigest: digest.nullable(),
  }),
]);
export const configurationNoGuardClosureSchema = z.strictObject({
  version: z.literal(2),
  identity: configurationSettlementOwnerIdentitySchema,
  ownerSequence: epoch,
  closedAt: epoch,
  noGuardEvidence: configurationNoGuardEvidenceSchema,
  originalContainmentDigests: digests,
  unusedSlotDigests: z
    .array(
      z.strictObject({
        role: z.enum(["ops-agent", "data-manager"]),
        intentDigest: digest,
        confirmationDigest: digest,
      }),
    )
    .max(2)
    .refine((items) => items.every((item, i) => i === 0 || items[i - 1]!.role < item.role)),
  closureDigest: digest,
});
const issuerUnused = z.strictObject({
  intent: signed(configurationUnusedCapacityIntentSchema),
  confirmation: signed(configurationUnusedCapacityConfirmationSchema),
});
export const configurationNoGuardBundleSchema = z.strictObject({
  version: z.literal(2),
  phase: z.literal("unused"),
  settlementId: digest,
  projectionDigest: digest,
  closure: signed(configurationNoGuardClosureSchema),
  issuerFreezeProof: z.union([
    signed(configurationNeverIssuedProofSchema),
    signed(configurationIssuedPrepareRefusedProofSchema),
  ]),
  issuerUnused,
});
export const configurationNoGuardIntentSchema = z.strictObject({
  ownerSequence: epoch,
  closedAt: epoch,
  noGuardEvidence: configurationNoGuardEvidenceSchema,
  issuerFreezeProof: z.union([
    signed(configurationNeverIssuedProofSchema),
    signed(configurationIssuedPrepareRefusedProofSchema),
  ]),
  issuerUnused: z.strictObject({
    intent: signed(configurationUnusedCapacityIntentSchema),
    confirmation: signed(configurationUnusedCapacityConfirmationSchema).nullable(),
  }),
  bundle: signed(configurationNoGuardBundleSchema).nullable(),
});
/** Fixed acyclic issuer source tuple, independent of a later closure. */
export function configurationIssuerUnusedSourceDigest(
  evidence: z.infer<typeof configurationNoGuardEvidenceSchema>,
): string {
  return settlementRecordDigest(
    configurationSettlementDomains.unusedIntent,
    evidence.kind === "never_issued"
      ? { issuerFreezeProofDigest: evidence.issuerFreezeProofDigest }
      : {
          issuerFreezeProofDigest: evidence.issuerFreezeProofDigest,
          refusalProjectionDigest: evidence.refusalProjectionDigest,
          dmUnusedConfirmationDigest: evidence.dmUnusedConfirmationDigest,
        },
  );
}
const pending = z.strictObject({
  version: z.literal(2),
  phase: z.literal("uncommitted"),
  identity: configurationSettlementOwnerIdentitySchema,
  referenceOperationFingerprint: digest,
});
export const configurationSettlementCommitmentCellSchema = signed(
  z.union([pending, configurationCommittedSettlementSchema, configurationNoGuardBundleSchema]),
);
export const configurationSettlementControlCellSchema = signed(
  z.union([
    z.strictObject({
      version: z.literal(2),
      projection: signedConfigurationReservationProjectionSchema,
      binding: z.literal(null),
    }),
    z.strictObject({
      version: z.literal(2),
      projection: signedConfigurationReservationProjectionSchema,
      binding: signed(configurationSettlementControlEnvelopeSchema),
    }),
    z.strictObject({
      version: z.literal(2),
      projection: signedConfigurationReservationProjectionSchema,
      binding: z.literal(null),
      unused: z.strictObject({
        bundleDigest: digest,
        closureDigest: digest,
        issuerFreezeProofDigest: digest,
        issuerUnusedIntentDigest: digest,
        issuerUnusedConfirmationDigest: digest,
      }),
    }),
  ]),
);
export const configurationDmCapacityCellSchema = z.strictObject({
  version: z.literal(2),
  capacity: signedConfigurationSettlementCapacitySchema.nullable(),
  refusal: signed(configurationDmNoGuardRefusalSchema).nullable(),
  unused: z
    .strictObject({
      intent: signed(configurationUnusedCapacityIntentSchema),
      confirmation: signed(configurationUnusedCapacityConfirmationSchema).nullable(),
    })
    .nullable(),
});
export const configurationSettlementDescriptorSchema = descriptor;
