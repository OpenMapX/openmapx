/** Private owner data schemas. Decoding does not create owner, inspection,
 * decision or settlement authority. */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  configurationMaintenanceDecisionSchema,
  configurationMaintenanceReceiptSchema,
  configurationMaintenanceSettleSchema,
} from "../ops/configuration-maintenance";
import { type OpsJobStatus, opsResourceId, parseOpsJobStatus } from "../ops/contract";
import { controlTerminalReceiptDigest } from "../ops/control-retention-receipt";
import {
  executionFingerprint,
  executionRefSchema,
  retainedParentExecutionSchema,
} from "../ops/execution-identity";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { ownedServiceSnapshotSchema } from "../ops/owned-service-records";
import {
  configurationNoGuardIntentSchema,
  configurationSettlementOwnerIdentitySchema,
  signedConfigurationSettlementCapacitySchema,
} from "./configuration-fence-settlement-records";
import {
  configurationMaintenanceFinalRecordSchema,
  signedConfigurationMaintenanceRuntimeInspectionSchema,
} from "./configuration-maintenance-final-records";
import { controlOriginSchema } from "./control-records";
import {
  coordinatorPullWitnessSchema,
  stagedCoordinatorObservationSchema,
} from "./coordinator-pull-records";
import { dataConfigurationFencePreparedWitnessSchema } from "./data-configuration-fence-witness-records";
import {
  assertFixedConfigurationMaintenancePlan,
  fixedConfigurationMaintenancePlanSchema,
} from "./fixed-configuration-maintenance";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  sequence = z.number().int().nonnegative().safe();
export const configurationMaintenanceControlSnapshotSchema = z.strictObject({
  preflight: z.lazy(() => configurationMaintenanceReceiptSchema.shape.preflight),
  sequence: z.lazy(() => configurationMaintenanceReceiptSchema.shape.sequence),
  state: z.lazy(() => configurationMaintenanceReceiptSchema.shape.state),
  decision: z.lazy(() => configurationMaintenanceReceiptSchema.shape.decision),
  dmFence: z.lazy(() => configurationMaintenanceReceiptSchema.shape.dmFence),
  generation: z.lazy(() => configurationMaintenanceReceiptSchema.shape.generation),
  appliedRevisionId: z.lazy(() => configurationMaintenanceReceiptSchema.shape.appliedRevisionId),
  followUp: z.lazy(() => configurationMaintenanceReceiptSchema.shape.followUp),
});
export const configurationMaintenanceDecisionCommitmentDomain =
  "openmapx-configuration-maintenance-decision-v1";
/** Produced in the actual original-owner authenticated decision CAS. This
 * non-secret attestation is copied verbatim by the fixed shared publisher. */
export const configurationMaintenanceDecisionCommitmentPayloadSchema = z.strictObject({
  version: z.literal(1),
  identity: z.lazy(() => configurationSettlementOwnerIdentitySchema),
  operation: z.lazy(() => configurationMaintenanceDecisionSchema),
  execution: executionRefSchema,
  apiParent: z
    .lazy(() => retainedParentExecutionSchema)
    .refine((parent) => parent.issuer === "api"),
  admittedAt: sequence,
  requestedDeadlineAt: sequence,
  acceptedAt: sequence,
  requestVersion: z.union([z.literal(1), z.literal(2)]),
  deploymentBudgetMs: z.number().int().min(1).max(60000),
  result: configurationMaintenanceControlSnapshotSchema,
  canonicalDigest: digest,
});
export const configurationMaintenanceDecisionCommitmentSchema = z.strictObject({
  payload: configurationMaintenanceDecisionCommitmentPayloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
/** The original owner's finite metadata control. This ExecutionRef is ONLY
 * journal/receipt correlation; it is never admitted as a forward execution,
 * target owner/borrower or a separate origin/family. */
export const configurationMaintenanceDecisionSourceSchema = z.strictObject({
  version: z.literal(1),
  operation: z.lazy(() => configurationMaintenanceDecisionSchema),
  execution: executionRefSchema,
  apiParent: z
    .lazy(() => retainedParentExecutionSchema)
    .refine((parent) => parent.issuer === "api"),
  parentAssertion: z.string().min(1).max(4096),
  admittedAt: sequence,
  requestedDeadlineAt: sequence,
  acceptedAt: sequence,
  requestVersion: z.union([z.literal(1), z.literal(2)]),
  deploymentBudgetMs: z.number().int().min(1).max(60000),
  result: configurationMaintenanceControlSnapshotSchema,
  canonicalDigest: digest,
  commitment: configurationMaintenanceDecisionCommitmentSchema,
  receiptDelivery: z
    .strictObject({
      terminalCopyId: z.uuid(),
      checkpointOwnerVersion: sequence,
      proofDigest: digest,
    })
    .nullable(),
});
export const configurationMaintenanceStepControlSourceSchema = z.strictObject({
  version: z.literal(1),
  ordinal: z.number().int().min(0).max(31),
  execution: executionRefSchema,
  apiParent: z
    .lazy(() => retainedParentExecutionSchema)
    .refine((parent) => parent.issuer === "api"),
  parentAssertion: z.string().min(1).max(4096),
  requestedDeadlineAt: sequence,
  receivedAt: sequence,
  grant: z
    .strictObject({ leaseId: z.uuid(), delegationId: z.uuid(), grantDigest: digest })
    .nullable(),
  canonical: z
    .strictObject({
      status: z
        .unknown()
        .transform((value) => parseOpsJobStatus(value) as OpsJobStatus)
        .refine((value) => value.diagnostics === undefined),
      terminalDigest: digest,
      terminalAt: sequence,
      effectSettlementDigest: digest,
    })
    .nullable(),
  receiptDelivery: z
    .strictObject({
      terminalCopyId: z.uuid(),
      checkpointOwnerVersion: sequence,
      proofDigest: digest,
    })
    .nullable(),
});
export const configurationMaintenanceSettleControlSourceSchema = z.strictObject({
  version: z.literal(1),
  operation: z.lazy(() => configurationMaintenanceSettleSchema),
  execution: executionRefSchema,
  apiParent: z
    .lazy(() => retainedParentExecutionSchema)
    .refine((parent) => parent.issuer === "api"),
  parentAssertion: z.string().min(1).max(4096),
  admittedAt: sequence,
  requestedDeadlineAt: sequence,
  acceptedAt: sequence,
  requestVersion: z.union([z.literal(1), z.literal(2)]),
  deploymentBudgetMs: z.number().int().min(1).max(60000),
  checkedSequence: sequence,
  requestEvidenceDigest: digest,
  completedAt: sequence.nullable(),
  result: configurationMaintenanceControlSnapshotSchema.nullable(),
  canonicalDigest: digest.nullable(),
  receiptDelivery: z
    .strictObject({
      terminalCopyId: z.uuid(),
      checkpointOwnerVersion: sequence,
      proofDigest: digest,
    })
    .nullable(),
});
export const configurationMaintenanceOwnerRecordSchema = z.strictObject({
  version: z.literal(2),
  installationId: z.uuid(),
  origin: controlOriginSchema,
  admissionDigest: digest,
  rootCertificateDigest: digest,
  apiParentAttestationDigest: digest,
  plan: z.lazy(() => fixedConfigurationMaintenancePlanSchema),
  originalContainers: z.array(ownedServiceSnapshotSchema).max(256),
  coordinatorPull: coordinatorPullWitnessSchema.optional(),
  stagedCoordinatorProvenance: stagedCoordinatorObservationSchema.optional(),
  sequence,
  receipt: z.lazy(() => configurationMaintenanceReceiptSchema),
  guardSource: z.lazy(() => dataConfigurationFencePreparedWitnessSchema).nullable(),
  capacity: z.lazy(() => signedConfigurationSettlementCapacitySchema).nullable(),
  apiControls: z.strictObject({
    decide: configurationMaintenanceDecisionSourceSchema.nullable(),
    settle: configurationMaintenanceSettleControlSourceSchema.nullable(),
    steps: z
      .array(configurationMaintenanceStepControlSourceSchema)
      .max(32)
      .refine((values) =>
        values.every((value, index) => index === 0 || values[index - 1]!.ordinal < value.ordinal),
      ),
  }),
  // Only the actual fixed final/inspection producers may install these states.
  final: z.lazy(() => configurationMaintenanceFinalRecordSchema).nullable(),
  inspection: z.lazy(() => signedConfigurationMaintenanceRuntimeInspectionSchema).nullable(),
  issuance: z.enum(["open", "closing_without_guard", "closed_without_guard"]),
  noGuard: z.lazy(() => configurationNoGuardIntentSchema).nullable(),
});
export type ConfigurationMaintenanceOwnerRecord = z.infer<
  typeof configurationMaintenanceOwnerRecordSchema
>;
/** Pure release-publication preimage, not proof of release. Callers MUST
 * independently verify the retained original physical release/full closure.
 * There is no new timestamp, outcome, inspection or control identity here. */
export function configurationMaintenanceReleasedOwner(
  owner: ConfigurationMaintenanceOwnerRecord,
): ConfigurationMaintenanceOwnerRecord {
  const retained = owner.apiControls.settle;
  if (
    owner.receipt.state !== "settling" ||
    owner.receipt.dmFence?.state !== "settled" ||
    !owner.guardSource ||
    owner.noGuard ||
    owner.issuance !== "open" ||
    !owner.final ||
    !owner.inspection ||
    (retained &&
      (retained.result !== null ||
        retained.completedAt !== null ||
        retained.canonicalDigest !== null))
  )
    throw Error("Original released owner transition required");
  const sequence = owner.sequence + 1;
  return configurationMaintenanceOwnerRecordSchema.parse({
    ...owner,
    sequence,
    receipt: { ...owner.receipt, sequence, state: "settled" },
  });
}
/** Pure deterministic completion preimage. Callers must independently verify
 * the original immutable final, full closure and retained physical release. */
export function configurationMaintenanceSettleCompletion(
  owner: ConfigurationMaintenanceOwnerRecord,
  releasedAt: number,
): ConfigurationMaintenanceOwnerRecord {
  const retained = owner.apiControls.settle;
  if (
    !retained ||
    owner.receipt.state !== "settled" ||
    !Number.isSafeInteger(releasedAt) ||
    releasedAt < retained.acceptedAt
  )
    throw Error("Original released settle completion required");
  const { preflight, sequence, state, decision, dmFence, generation, appliedRevisionId, followUp } =
      owner.receipt,
    result = configurationMaintenanceControlSnapshotSchema.parse({
      preflight,
      sequence,
      state,
      decision,
      dmFence,
      generation,
      appliedRevisionId,
      followUp,
    }),
    status: OpsJobStatus = {
      version: 2,
      admittedAt: retained.admittedAt,
      deadlineAt: retained.execution.deadlineAt,
      fingerprint: retained.execution.fingerprint,
      operationId: retained.execution.executionId,
      operationKey: retained.execution.operationKey,
      kind: "configurationMaintenance.settle",
      resourceId: opsResourceId(retained.operation),
      state: "succeeded",
      submittedAt: new Date(retained.admittedAt).toISOString(),
      updatedAt: new Date(releasedAt).toISOString(),
      result: { ...owner.receipt, ...result },
    },
    completed = configurationMaintenanceSettleControlSourceSchema.parse({
      ...retained,
      completedAt: releasedAt,
      result,
      canonicalDigest: controlTerminalReceiptDigest(status),
    });
  if (
    retained.result &&
    (canonicalJson(retained.result) !== canonicalJson(completed.result) ||
      retained.completedAt !== completed.completedAt ||
      retained.canonicalDigest !== completed.canonicalDigest)
  )
    throw Error("Original settle completion preimage changed");
  return { ...owner, apiControls: { ...owner.apiControls, settle: completed } };
}
export function configurationMaintenanceDecisionCommitmentPayload(
  owner: ConfigurationMaintenanceOwnerRecord,
  source: Pick<
    z.infer<typeof configurationMaintenanceDecisionSourceSchema>,
    | "operation"
    | "execution"
    | "apiParent"
    | "admittedAt"
    | "requestedDeadlineAt"
    | "acceptedAt"
    | "requestVersion"
    | "deploymentBudgetMs"
    | "result"
    | "canonicalDigest"
  >,
) {
  return configurationMaintenanceDecisionCommitmentPayloadSchema.parse({
    version: 1,
    identity: {
      installationId: owner.installationId,
      origin: owner.origin,
      ownerPrepare: owner.plan.prepare,
      admissionDigest: owner.admissionDigest,
      rootCertificateDigest: owner.rootCertificateDigest,
      maintenanceId: owner.plan.operation.maintenanceId,
      candidateId: owner.plan.operation.candidateId,
      planDigest: owner.plan.planDigest,
      settlementId: owner.plan.dmSettle.settlementId,
    },
    operation: source.operation,
    execution: source.execution,
    apiParent: source.apiParent,
    admittedAt: source.admittedAt,
    requestedDeadlineAt: source.requestedDeadlineAt,
    acceptedAt: source.acceptedAt,
    requestVersion: source.requestVersion,
    deploymentBudgetMs: source.deploymentBudgetMs,
    result: source.result,
    canonicalDigest: source.canonicalDigest,
  });
}
/** Consistency only. Callers MUST first authenticate the actual indexed private
 * owner with its pinned role key; parsing or calling this creates no handle. */
export function assertConfigurationMaintenanceDecisionSource(
  owner: ConfigurationMaintenanceOwnerRecord,
): void {
  assertFixedConfigurationMaintenancePlan(owner.plan, owner.installationId);
  const source = owner.apiControls.decide;
  if (!source) {
    if (
      owner.receipt.decision !== null ||
      owner.apiControls.steps.length ||
      owner.apiControls.settle
    )
      throw Error("Original authenticated decision source required");
    return;
  }
  const body = source.operation,
    parent = source.apiParent,
    original = owner.plan.apiParent,
    result = source.result;
  if (
    canonicalJson(source.commitment.payload) !==
    canonicalJson(configurationMaintenanceDecisionCommitmentPayload(owner, source))
  )
    throw Error("Original signed decision commitment preimage changed");
  if (
    parent.issuer !== "api" ||
    original.issuer !== "api" ||
    !owner.guardSource ||
    owner.noGuard ||
    body.maintenanceId !== owner.plan.operation.maintenanceId ||
    body.candidateId !== owner.plan.operation.candidateId ||
    body.prepareOperationKey !== owner.plan.prepare.operationKey ||
    body.prepareFingerprint !== owner.plan.prepare.operationFingerprint ||
    body.planDigest !== owner.plan.planDigest ||
    body.expectedSequence + 1 !== result.sequence ||
    owner.sequence < result.sequence ||
    body.checkpointVersion < 1 ||
    body.checkpointVersion > parent.apiOwnerVersion ||
    parent.apiJobId !== original.apiJobId ||
    parent.operationKey !== original.operationKey ||
    parent.fingerprint !== original.fingerprint ||
    parent.deadlineAt !== original.deadlineAt ||
    createHash("sha256").update(source.parentAssertion).digest("hex") !== parent.assertionDigest ||
    source.execution.executor !== "ops-agent" ||
    source.execution.principal !== "api" ||
    source.execution.operationFingerprint !== opsOperationFingerprint(body) ||
    source.execution.fingerprint !==
      executionFingerprint({
        kind: body.kind,
        operationFingerprint: source.execution.operationFingerprint,
        deadlineAt: source.execution.deadlineAt,
        parent,
      }) ||
    source.execution.deadlineAt <= source.admittedAt ||
    source.execution.deadlineAt !==
      Math.min(
        source.requestedDeadlineAt,
        body.decision === "continue" ? parent.deadlineAt : Infinity,
        source.admittedAt + source.deploymentBudgetMs,
      ) ||
    source.acceptedAt < source.admittedAt ||
    source.acceptedAt >= source.execution.deadlineAt ||
    result.state !== "authorized" ||
    result.preflight !== (body.decision === "abandon" ? "unavailable" : "current") ||
    result.generation !== "not_started" ||
    result.appliedRevisionId !== null ||
    result.followUp !== "not_started" ||
    canonicalJson(result.dmFence) !== canonicalJson(owner.guardSource.preparedReceipt) ||
    canonicalJson(result.decision) !==
      canonicalJson({
        decisionId: body.decisionId,
        decision: body.decision,
        checkpointVersion: body.checkpointVersion,
        checkpointDigest: body.checkpointDigest,
      }) ||
    canonicalJson(owner.receipt.decision) !== canonicalJson(result.decision) ||
    (source.receiptDelivery &&
      source.receiptDelivery.checkpointOwnerVersion < parent.apiOwnerVersion)
  )
    throw Error("Original authenticated decision source changed");
  const receipt = configurationMaintenanceReceiptSchema.parse({ ...owner.receipt, ...result });
  if (
    source.canonicalDigest !==
    controlTerminalReceiptDigest({
      version: 2,
      admittedAt: source.admittedAt,
      deadlineAt: source.execution.deadlineAt,
      fingerprint: source.execution.fingerprint,
      operationId: source.execution.executionId,
      operationKey: source.execution.operationKey,
      kind: body.kind,
      resourceId: opsResourceId(body),
      state: "succeeded",
      submittedAt: new Date(source.admittedAt).toISOString(),
      updatedAt: new Date(source.acceptedAt).toISOString(),
      result: receipt,
    })
  )
    throw Error("Original decision canonical source changed");
  for (const control of owner.apiControls.steps) {
    const step = owner.plan.steps[control.ordinal],
      actor = control.apiParent,
      original = owner.plan.apiParent,
      parent = {
        issuer: "ops-agent" as const,
        operationKey: owner.plan.prepare.operationKey,
        fingerprint: owner.plan.prepare.fingerprint,
        deadlineAt: owner.plan.prepare.deadlineAt,
        execution: owner.plan.prepare,
      };
    if (
      !step ||
      source.operation.decision !== "continue" ||
      !source.receiptDelivery ||
      actor.issuer !== "api" ||
      original.issuer !== "api" ||
      actor.apiJobId !== original.apiJobId ||
      actor.operationKey !== original.operationKey ||
      actor.fingerprint !== original.fingerprint ||
      actor.deadlineAt !== original.deadlineAt ||
      createHash("sha256").update(control.parentAssertion).digest("hex") !==
        actor.assertionDigest ||
      control.requestedDeadlineAt !== owner.plan.prepare.deadlineAt ||
      control.execution.executor !== "ops-agent" ||
      control.execution.principal !== "api" ||
      control.execution.operationKey !== step.operationKey ||
      control.execution.operationFingerprint !== step.operationFingerprint ||
      control.execution.deadlineAt > owner.plan.prepare.deadlineAt ||
      control.execution.deadlineAt <= control.receivedAt ||
      control.execution.fingerprint !==
        executionFingerprint({
          kind: step.operation.kind,
          operationFingerprint: step.operationFingerprint,
          deadlineAt: control.execution.deadlineAt,
          parent,
        }) ||
      (control.receiptDelivery &&
        (!control.grant ||
          !control.canonical ||
          control.receiptDelivery.checkpointOwnerVersion < actor.apiOwnerVersion))
    )
      throw Error("Original purpose-bound frozen maintenance step changed");
    if (control.canonical) {
      const canonical = control.canonical,
        status = canonical.status;
      if (
        !control.grant ||
        status.state !== "succeeded" ||
        status.kind !== step.operation.kind ||
        status.operationId !== control.execution.executionId ||
        status.operationKey !== control.execution.operationKey ||
        status.fingerprint !== control.execution.fingerprint ||
        status.deadlineAt !== control.execution.deadlineAt ||
        canonical.terminalDigest !== controlTerminalReceiptDigest(status)
      )
        throw Error("Original maintenance child canonical source changed");
    }
  }
  const settle = owner.apiControls.settle;
  if (settle) {
    const body = settle.operation,
      parent = settle.apiParent;
    if (
      parent.issuer !== "api" ||
      body.maintenanceId !== owner.plan.operation.maintenanceId ||
      body.candidateId !== owner.plan.operation.candidateId ||
      body.prepareOperationKey !== owner.plan.prepare.operationKey ||
      body.prepareFingerprint !== owner.plan.prepare.operationFingerprint ||
      body.planDigest !== owner.plan.planDigest ||
      body.decisionId !== owner.receipt.decision?.decisionId ||
      body.expectedSequence !== settle.checkedSequence ||
      body.evidenceDigest !== settle.requestEvidenceDigest ||
      owner.sequence <= settle.checkedSequence ||
      parent.apiJobId !== original.apiJobId ||
      parent.operationKey !== original.operationKey ||
      parent.fingerprint !== original.fingerprint ||
      parent.deadlineAt !== original.deadlineAt ||
      createHash("sha256").update(settle.parentAssertion).digest("hex") !==
        parent.assertionDigest ||
      settle.execution.executor !== "ops-agent" ||
      settle.execution.principal !== "api" ||
      settle.execution.operationFingerprint !== opsOperationFingerprint(body) ||
      settle.execution.fingerprint !==
        executionFingerprint({
          kind: body.kind,
          operationFingerprint: settle.execution.operationFingerprint,
          deadlineAt: settle.execution.deadlineAt,
          parent,
        }) ||
      settle.execution.deadlineAt !==
        Math.min(settle.requestedDeadlineAt, settle.admittedAt + settle.deploymentBudgetMs) ||
      settle.acceptedAt < settle.admittedAt ||
      settle.acceptedAt >= settle.execution.deadlineAt ||
      (settle.result === null &&
        (settle.completedAt !== null ||
          settle.canonicalDigest !== null ||
          settle.receiptDelivery !== null)) ||
      (settle.result !== null &&
        (settle.completedAt === null ||
          settle.canonicalDigest === null ||
          settle.completedAt < settle.acceptedAt ||
          settle.result.state !== "settled" ||
          settle.result.dmFence?.state !== "settled"))
    )
      throw Error("Original accepted settlement request source changed");
  }
}
