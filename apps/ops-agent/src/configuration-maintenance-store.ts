import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import {
  observeCoordinatorPullForMaintenance,
  observedCoordinatorPullBaseline,
  ownedCoordinatorPullBaseline,
  ownedStagedCoordinatorBaseline,
  type VerifiedCoordinatorPullBaseline,
  verifiedStagedCoordinatorOwnershipState,
  verifyConfigurationReleaseSourceWitness,
} from "@openmapx/core/build-artifacts";
import { coordinatorPullSubmissionDigest, parseOpsJobStatus } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { assertProspectiveConfigurationMaintenanceBudget } from "../../../packages/core/src/build-artifacts/configuration-maintenance-budget";
import type { ConfigurationReleaseSnapshot } from "../../../packages/core/src/build-artifacts/configuration-release-snapshot";
import {
  readConfigurationHandoffReleaseOverlay,
  readConfigurationHandoffReleaseState,
} from "../../../packages/core/src/build-artifacts/configuration-source-witness";
import {
  type CoordinatorPullWitness,
  coordinatorPullObservationDomain,
  coordinatorPullWitnessPayloadSchema,
  type StagedCoordinatorObservation,
  stagedCoordinatorObservationDomain,
  stagedCoordinatorObservationPayloadSchema,
  stagedCoordinatorObservationSchema,
} from "../../../packages/core/src/build-artifacts/coordinator-pull-records";
import { readOwnedGenerationHardlinkPlan } from "../../../packages/core/src/build-artifacts/generation-hardlinks-owner";
import {
  type ConfigurationCandidateSource,
  readConfigurationCandidate,
  readRetainedConfigurationCandidate,
} from "./configuration-candidate-source";
import {
  assertConfigurationCoordinatorReady,
  configurationDataManagerTransport,
} from "./configuration-hardlinks-runtime";
import { inspectMaintenanceDockerRuntime } from "./configuration-maintenance-docker-inspection";
import {
  preflightConfigurationRelease,
  verifyFrozenConfigurationRelease,
} from "./configuration-release-preflight";
import type { DockerRuntimeOptions } from "./docker-runtime";
import type { OpsJobJournal } from "./journal";
import {
  inspectLiteralStagedConfigurationDependency,
  inspectOriginalCoordinatorServices,
  inspectStagedCoordinatorMaintenanceSource,
  inspectStagedCoordinatorOwnerServices,
  type OwnedServiceResolver,
  type OwnedServiceSnapshot,
} from "./owned-services";
import { coordinatorCandidateMetadata, renderCoordinatorCandidate } from "./service-pull-runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";
/** The fixed agent owner store. The only initializer consumes an actual
 * production admission; no structural plan or caller-selected final state is
 * an owner-store capability. */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type ArtifactTargetLease,
  adoptArtifactTargetLease,
  assertArtifactTargetLeaseExecution,
  assertConfigurationMaintenanceRootClosure,
  assertFixedConfigurationMaintenancePlan,
  bindControlChildPhase,
  buildFixedConfigurationMaintenancePlan,
  type ControlInstallation,
  cancelArtifactTargetLease,
  cancelControlExecution,
  closeArtifactTargetLeaseHandle,
  configurationMaintenanceTargetOwner,
  consumeControlChildDispatch,
  controlDigest,
  controlRolePublicKey,
  executionAuthorityState,
  type FixedConfigurationMaintenancePlan,
  inspectArtifactDelegation,
  inspectArtifactTargetLeaseChildSettlement,
  issueControlChildPhase,
  lookupControlChildPhaseBinding,
  readPrivateRecord,
  reconcileArtifactTargetLease,
  restoreAdmittedControlExecution,
  restoreArtifactTargetLeaseForSettlement,
  restoreConfigurationMaintenancePhaseIssuer,
  retainControlEffectReceipt,
  settlePreparedConfigurationHandoff,
  signControl,
  type VerifiedExecutionAuthority,
  verifiedParentForArtifactDelegation,
  verifyConfigurationSourceWitness,
  verifyControl,
  verifyControlEffectSettlement,
  verifyControlRecoveryAuthority,
  verifyFamilyOwnedRecord,
  verifyMaintenanceCoordinatorPrerequisite,
  verifyRetainedArtifactTargetRootRelease,
  verifyRetainedLocalControlPeer,
  withConfigurationMaintenanceDecisionPublication,
  withConfigurationMaintenanceOwnerInitialization,
  withConfigurationMaintenanceOwnerObservation,
  withConfigurationMaintenancePhasePublication,
  writePrivateRecord,
} from "@openmapx/core/build-artifacts";
import {
  DataManagerHttpError,
  inspectDataConfigurationFence,
  prepareDataConfigurationFence,
  recoverUnadmittedConfigurationPreparation,
  settleDataConfigurationFence,
} from "@openmapx/core/data-manager-sdk";
import {
  acquireTrustedConfigurationQueueLock,
  type ConfigurationMaintenanceDecision,
  type ConfigurationMaintenancePrepare,
  type ConfigurationMaintenanceReceipt,
  type ConfigurationMaintenanceSettle,
  canonicalJson,
  configurationMaintenancePrepareSchema,
  configurationMaintenanceSettleRequestDigest,
  controlTerminalReceiptDigest,
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
  type OpsJobStatus,
  type OpsOperation,
  opsOperationFingerprint,
  opsResourceId,
  protectedConfigurationServiceIdSchema,
  type RetainedParentExecution,
  type TrustedConfigurationQueueLock,
  type VerifiedParentExecution,
  verifiedApiJobParentBinding,
  verifyApiRetentionProof,
} from "@openmapx/core/ops";
import {
  inspectControlChildPublication,
  lookupControlChildPhaseAttempt,
} from "../../../packages/core/src/build-artifacts/child-phase";
import { readOriginalMaintenanceFinalChildren } from "../../../packages/core/src/build-artifacts/configuration-maintenance-final-children";
import {
  assertAppliedConfigurationMaintenanceFinalState,
  assertContainedConfigurationMaintenanceFinalState,
  assertUnusedConfigurationMaintenanceFinalState,
  configurationFinalEvidenceProjectionSchema,
  configurationFinalEvidenceSchema,
  configurationMaintenanceFinalRecordSchema,
  configurationMaintenanceRequiredChecksSchema,
  configurationMaintenanceRuntimeInspectionSchema,
  configurationOwnerFinalSchema,
  configurationOwnerIdentitySchema,
  configurationFinalDomains as domains,
  finalRecordDigest,
} from "../../../packages/core/src/build-artifacts/configuration-maintenance-final-records";
import {
  assertConfigurationMaintenanceDecisionSource,
  type ConfigurationMaintenanceOwnerRecord,
  configurationMaintenanceControlSnapshotSchema,
  configurationMaintenanceDecisionCommitmentDomain,
  configurationMaintenanceDecisionCommitmentPayload,
  configurationMaintenanceDecisionCommitmentPayloadSchema,
  configurationMaintenanceDecisionSourceSchema,
  configurationMaintenanceReleasedOwner,
  configurationMaintenanceSettleCompletion,
  configurationMaintenanceSettleControlSourceSchema,
  configurationMaintenanceStepControlSourceSchema,
  configurationMaintenanceOwnerRecordSchema as ownerSchema,
} from "../../../packages/core/src/build-artifacts/configuration-maintenance-owner-records";
import {
  childSettlementState,
  configurationMaintenanceChildState,
  installationState,
  publishConfigurationMaintenanceForwardWitness,
  readCompletedConfigurationHandoff,
  verifyConfigurationMaintenanceChildTerminal,
  verifyControlPreparedTerminal,
  withPrivateEffectWriter,
} from "../../../packages/core/src/build-artifacts/control-authority";
import { CONTROL_RETENTION_LIMITS } from "../../../packages/core/src/build-artifacts/control-retention";
import { repairIndexedConfigurationMaintenanceSettleCompletion } from "../../../packages/core/src/build-artifacts/retention-family";
import {
  observeConfigurationMaintenanceRuntimeTree,
  readConfigurationPrepareNonAdmission,
} from "../../../packages/core/src/build-artifacts/target-lease";
import type { DataConfigurationFenceReceipt } from "../../../packages/core/src/services/data-manager/contracts/configuration-maintenance";

import type { PersistedOpsJob } from "./journal";
import { OpsExecutionFailure, type OpsRuntime } from "./runtime";

export type { ConfigurationMaintenanceOwnerRecord };

const domain = "openmapx-configuration-maintenance-owner-v2";
function ownerName(authority: VerifiedExecutionAuthority): string {
  const state = executionAuthorityState(authority);
  const admitted = readPrivateRecord(
    state.installation,
    "executions",
    `${state.execution.operationKey}.json`,
    65536,
  ) as { payload?: { operation?: unknown } };
  return `${configurationMaintenancePrepareSchema.parse(admitted.payload?.operation).maintenanceId}.json`;
}
function assertOwner(
  authority: VerifiedExecutionAuthority,
  owner: ConfigurationMaintenanceOwnerRecord,
): void {
  const state = executionAuthorityState(authority),
    parent = owner.plan.apiParent,
    admitted = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ) as { payload?: { operation?: unknown; parent?: unknown } },
    { kind: _kind, ...binding } = owner.plan.operation;
  assertFixedConfigurationMaintenancePlan(owner.plan, owner.installationId);
  assertConfigurationMaintenanceDecisionSource(owner);
  if (owner.apiControls.decide)
    verifyControl(
      state.installation.installation.publicKey,
      configurationMaintenanceDecisionCommitmentDomain,
      owner.apiControls.decide.commitment,
      configurationMaintenanceDecisionCommitmentPayloadSchema,
    );
  for (const source of owner.apiControls.steps) {
    const step = owner.plan.steps[source.ordinal],
      reservation = owner.plan.reservations.find((value) => value.ordinal === source.ordinal),
      binding = reservation && lookupControlChildPhaseBinding(authority, reservation),
      publication =
        reservation && inspectControlChildPublication(authority, reservation).publication;
    if (
      !step ||
      !binding ||
      canonicalJson(binding.child.execution) !== canonicalJson(source.execution) ||
      (source.grant &&
        (!publication ||
          publication.state !== "grant_prepared" ||
          publication.leaseId !== source.grant.leaseId ||
          publication.delegationId !== source.grant.delegationId ||
          publication.grantDigest !== source.grant.grantDigest))
    )
      throw Error("Original frozen maintenance phase source changed");
    if (source.grant) {
      // Private integrity only. A signed/indexed original phase cell binds
      // these exact original outbox bytes. Physical tree verification belongs
      // to the caller's lease scope/adoption; reopening its writer here nests
      // the same lease journal while that scope is held.
      const outbox = readPrivateRecord(
        state.installation,
        "attempts",
        `${source.grant.delegationId}.json`,
        65536,
      ) as { grant?: unknown };
      if (controlDigest(outbox.grant) !== source.grant.grantDigest)
        throw Error("Original frozen phase outbox changed");
    }
  }
  if (
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent" ||
    state.kind !== "configurationMaintenance.prepare" ||
    !state.origin ||
    owner.installationId !== state.installation.installation.installationId ||
    controlDigest(owner.origin) !== controlDigest(state.origin) ||
    owner.admissionDigest !== state.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution) ||
    controlDigest(admitted) !== state.receiptDigest ||
    canonicalJson(owner.plan.operation) !== canonicalJson(admitted.payload?.operation) ||
    canonicalJson(parent) !== canonicalJson(admitted.payload?.parent) ||
    canonicalJson(owner.receipt.binding) !== canonicalJson(binding) ||
    canonicalJson(owner.plan.reservations) !== canonicalJson(state.reservations) ||
    canonicalJson(owner.receipt.prepare) !== canonicalJson(state.execution) ||
    owner.receipt.planDigest !== owner.plan.planDigest ||
    owner.receipt.binding.maintenanceId !== owner.plan.operation.maintenanceId ||
    owner.receipt.binding.candidateId !== owner.plan.operation.candidateId ||
    parent.issuer !== "api" ||
    owner.receipt.apiJobId !== parent.apiJobId ||
    owner.receipt.parentOperationKey !== parent.operationKey ||
    owner.receipt.parentFingerprint !== parent.fingerprint ||
    owner.receipt.parentDeadlineAt !== parent.deadlineAt ||
    canonicalJson(owner.receipt.steps) !== canonicalJson(owner.plan.steps) ||
    canonicalJson(owner.receipt.serviceIds) !== canonicalJson(owner.plan.serviceIds) ||
    owner.apiParentAttestationDigest !== parent.assertionDigest ||
    owner.sequence !== owner.receipt.sequence
  )
    throw Error("Original configuration maintenance owner identity changed");
  const expectedImage = owner.plan.coordinatorImage;
  if (owner.stagedCoordinatorProvenance) {
    const copy = verifyControl(
      state.installation.installation.publicKey,
      stagedCoordinatorObservationDomain,
      owner.stagedCoordinatorProvenance,
      stagedCoordinatorObservationPayloadSchema,
    );
    if (
      owner.coordinatorPull ||
      expectedImage?.action !== "apply" ||
      copy.installationId !== owner.installationId ||
      canonicalJson(copy.ownerPrepare) !== canonicalJson(owner.plan.prepare) ||
      copy.candidateId !== binding.candidateId ||
      copy.planDigest !== owner.plan.planDigest ||
      copy.source.baseline.configurationRevisionId !== binding.expectedCurrentRevisionId ||
      canonicalJson(owner.originalContainers.find((c) => c.serviceId === "data-manager")) !==
        canonicalJson(copy.source.baseline.container)
    )
      throw Error("Original staged owner observation changed");
  }
  if (expectedImage?.action === "update") {
    if (!owner.coordinatorPull) throw Error("Original copied coordinator pull required");
    const pull = verifyControl(
      state.installation.installation.publicKey,
      coordinatorPullObservationDomain,
      owner.coordinatorPull,
      coordinatorPullWitnessPayloadSchema,
    );
    if (
      pull.installationId !== owner.installationId ||
      pull.maintenanceId !== binding.maintenanceId ||
      pull.candidateId !== binding.candidateId ||
      canonicalJson(pull.maintenancePrepare) !== canonicalJson(owner.plan.prepare) ||
      pull.sourceRevision !== binding.expectedSourceRevision ||
      pull.revisionId !== binding.expectedCurrentRevisionId ||
      pull.submissionDigest !== expectedImage.pullSubmissionDigest ||
      pull.imageId !== expectedImage.imageId ||
      pull.imageReference !== expectedImage.imageReference ||
      pull.releaseSelectionDigest !== expectedImage.releaseSelectionDigest
    )
      throw Error("Original coordinator pull/image expectation changed");
  } else if (owner.coordinatorPull) throw Error("Unexpected coordinator pull observation");
}
function read(authority: VerifiedExecutionAuthority): ConfigurationMaintenanceOwnerRecord {
  const state = executionAuthorityState(authority),
    name = ownerName(authority),
    raw = readPrivateRecord(state.installation, "configuration-maintenance", name);
  const owner = verifyControl(state.installation.installation.publicKey, domain, raw, ownerSchema);
  assertOwner(authority, owner);
  verifyFamilyOwnedRecord(
    state.installation,
    owner.origin,
    { scope: "private", namespace: "configuration-maintenance", name, container: "" },
    canonicalJson(raw),
  );
  return owner;
}
function write(
  authority: VerifiedExecutionAuthority,
  value: ConfigurationMaintenanceOwnerRecord,
  exclusive = false,
): void {
  const state = executionAuthorityState(authority),
    owner = ownerSchema.parse(value);
  assertOwner(authority, owner);
  const signed = signControl(state.installation.privateKey, domain, owner);
  if (Buffer.byteLength(canonicalJson(signed)) > 128 * 1024)
    throw Error("Configuration maintenance owner capacity exceeded");
  writePrivateRecord(
    state.installation,
    "configuration-maintenance",
    ownerName(authority),
    signed,
    exclusive,
    owner.origin,
  );
}
export function retainOwnedConfigurationMaintenance(
  authority: VerifiedExecutionAuthority,
  lease: ArtifactTargetLease,
  admission: ConfigurationMaintenanceAdmission,
): void {
  const state = executionAuthorityState(authority),
    source = configurationMaintenanceAdmissionState(admission),
    root = configurationMaintenanceTargetOwner(lease),
    plan = source.plan;
  if (
    !state.origin ||
    canonicalJson(root.execution) !== canonicalJson(plan.prepare) ||
    canonicalJson(root.serviceIds) !== canonicalJson(plan.serviceIds) ||
    plan.apiParent.issuer !== "api"
  )
    throw Error("Actual admitted maintenance closure required");
  const { kind: _kind, ...binding } = plan.operation;
  const owner = ownerSchema.parse({
    version: 2,
    installationId: state.installation.installation.installationId,
    origin: state.origin,
    admissionDigest: state.receiptDigest,
    rootCertificateDigest: root.certificateDigest,
    apiParentAttestationDigest: plan.apiParent.assertionDigest,
    plan,
    originalContainers: source.originalContainers,
    ...(source.coordinatorPull ? { coordinatorPull: source.coordinatorPull } : {}),
    ...(source.stagedCoordinatorProvenance
      ? { stagedCoordinatorProvenance: source.stagedCoordinatorProvenance }
      : {}),
    sequence: 0,
    preparedFence: null,
    apiControls: { decide: null, settle: null, steps: [] },
    final: null,
    inspection: null,
    receipt: {
      version: 1,
      binding,
      prepare: plan.prepare,
      apiJobId: plan.apiParent.apiJobId,
      parentOperationKey: plan.apiParent.operationKey,
      parentFingerprint: plan.apiParent.fingerprint,
      parentDeadlineAt: plan.apiParent.deadlineAt,
      planDigest: plan.planDigest,
      serviceIds: plan.serviceIds,
      steps: plan.steps,
      preflight: "current",
      sequence: 0,
      state: "preparing",
      decision: null,
      dmFence: null,
      generation: "not_started",
      appliedRevisionId: null,
      followUp: "not_started",
    },
  });
  withConfigurationMaintenanceOwnerInitialization(lease, authority, () =>
    write(authority, owner, true),
  );
  publishConfigurationMaintenanceForwardWitness(authority);
}
export function readOwnedConfigurationMaintenance(
  authority: VerifiedExecutionAuthority,
): ConfigurationMaintenanceOwnerRecord {
  return read(authority);
}
/** The release a maintenance froze, once its data fence is prepared. Callers use
 * it to re-check from the snapshot and local images instead of the registry.
 * Returns nothing while the maintenance has no prepared fence. */
export function readPreparedMaintenanceRelease(
  installation: ControlInstallation,
  maintenanceId: string,
): ConfigurationReleaseSnapshot | undefined {
  let raw: unknown;
  try {
    raw = readPrivateRecord(
      installationState(installation),
      "configuration-maintenance",
      `${maintenanceId}.json`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const owner = verifyControl(installation.publicKey, domain, raw, ownerSchema);
  return owner.receipt.dmFence ? owner.plan.release : undefined;
}
/** Observation-only completion of the original prepared handoff. All sources
 * and physical descendants must already be settled; this runs no Docker I/O. */
async function observeOwnedConfigurationHandoff(
  authority: VerifiedExecutionAuthority,
): Promise<void> {
  const owner = read(authority);
  if (
    !owner.plan.handoff ||
    owner.receipt.followUp === "complete" ||
    owner.final ||
    owner.receipt.generation !== "committed"
  )
    return;
  const step = owner.plan.steps.find((value) => value.phase === "maintenance-handoff"),
    source = owner.apiControls.steps.find((value) => value.ordinal === step?.ordinal);
  if (!source?.canonical || !source.receiptDelivery) return;
  await settlePreparedConfigurationHandoff(
    restoreAdmittedControlExecution(
      executionAuthorityState(authority).installation.installation,
      source.execution,
    ),
  );
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    readOriginalMaintenanceFinalChildren(
      authority,
      observeConfigurationMaintenanceRuntimeTree(authority),
    );
    withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
      const current = read(authority);
      if (current.receipt.followUp === "complete") return;
      if (canonicalJson(current) !== canonicalJson(owner))
        throw Error("Original handoff owner changed during completion");
      const sequence = current.sequence + 1;
      write(authority, {
        ...current,
        sequence,
        receipt: { ...current.receipt, sequence, followUp: "complete" },
      });
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
declare const controlOwnerBrand: unique symbol;
export type ConfigurationMaintenanceControlOwner = Readonly<{ [controlOwnerBrand]: true }>;
const controlOwners = new WeakMap<
  ConfigurationMaintenanceControlOwner,
  Readonly<{
    authority: VerifiedExecutionAuthority;
    requestKey: string;
    operationFingerprint: string;
    parent: VerifiedParentExecution;
    requestedDeadlineAt: number;
  }>
>();
export class ConfigurationMaintenanceControlUnauthorized extends Error {}
export class ConfigurationMaintenanceControlConflict extends Error {}
/** Fixed original-owner lookup consumes the actual live API HMAC binding.
 * UUIDs, parsed parents, a body hash or public prepared status grant nothing. */
export function admitConfigurationMaintenanceControlOwner(
  installation: ControlInstallation,
  operation: Extract<
    OpsOperation,
    {
      kind:
        | "configurationMaintenance.inspect"
        | "configurationMaintenance.decide"
        | "configurationMaintenance.settle";
    }
  >,
  parent: VerifiedParentExecution | undefined,
  request: { operationKey: string; requestedDeadlineAt?: number },
): ConfigurationMaintenanceControlOwner {
  const actor = verifiedApiJobParentBinding(parent),
    fingerprint = opsOperationFingerprint(operation),
    local = installationState(installation);
  if (
    installation.role !== "ops-agent" ||
    local.fixedChildId ||
    actor.childOperationKey !== request.operationKey ||
    actor.childOperationFingerprint !== fingerprint ||
    actor.requestedDeadlineAt !== request.requestedDeadlineAt
  )
    throw new ConfigurationMaintenanceControlUnauthorized("Original API control body required");
  const raw = readPrivateRecord(
      local,
      "configuration-maintenance",
      `${operation.maintenanceId}.json`,
    ),
    observed = verifyControl(installation.publicKey, domain, raw, ownerSchema),
    authority = restoreAdmittedControlExecution(installation, observed.plan.prepare),
    owner = read(authority),
    original = owner.plan.apiParent;
  if (
    owner.plan.operation.maintenanceId !== operation.maintenanceId ||
    owner.plan.operation.candidateId !== operation.candidateId ||
    actor.apiJobId !== original.apiJobId ||
    actor.parentOperationKey !== original.operationKey ||
    actor.parentFingerprint !== original.fingerprint ||
    actor.parentDeadlineAt !== original.deadlineAt
  )
    throw new ConfigurationMaintenanceControlUnauthorized(
      "Original API maintenance actor required",
    );
  if (
    operation.kind !== "configurationMaintenance.inspect" &&
    (operation.prepareOperationKey !== owner.plan.prepare.operationKey ||
      operation.prepareFingerprint !== owner.plan.prepare.operationFingerprint ||
      operation.planDigest !== owner.plan.planDigest)
  )
    throw new ConfigurationMaintenanceControlUnauthorized(
      "Original prepared decision binding required",
    );
  const value = Object.freeze({}) as ConfigurationMaintenanceControlOwner;
  controlOwners.set(
    value,
    Object.freeze({
      authority,
      requestKey: request.operationKey,
      operationFingerprint: fingerprint,
      parent: parent!,
      requestedDeadlineAt: actor.requestedDeadlineAt,
    }),
  );
  return value;
}
export function configurationMaintenanceControlOwnerState(
  value: ConfigurationMaintenanceControlOwner | undefined,
  operation: OpsOperation,
  requestKey: string,
) {
  const source = value && controlOwners.get(value);
  if (
    !source ||
    source.requestKey !== requestKey ||
    source.operationFingerprint !== opsOperationFingerprint(operation)
  )
    throw new ConfigurationMaintenanceControlUnauthorized(
      "Actual original maintenance control source required",
    );
  executionAuthorityState(source.authority);
  return source;
}
/** Fixed original-owner local generation admission. Actual API HMAC provenance,
 * candidate/guard preflight and retained one-use phase are all mandatory. The
 * ordinary transport peer resolver is unchanged; no API self-peer is accepted. */
export async function prepareOwnedConfigurationMaintenanceStepAdmission(
  runtime: OpsRuntime,
  installation: ControlInstallation,
  operation: OpsOperation,
  parent: VerifiedParentExecution | undefined,
  request: {
    operationKey: string;
    requestedDeadlineAt?: number;
    parentAssertion: string;
    signal: AbortSignal;
  },
) {
  const actor = verifiedApiJobParentBinding(parent),
    local = installationState(installation),
    fingerprint = opsOperationFingerprint(operation);
  if (
    installation.role !== "ops-agent" ||
    local.fixedChildId ||
    !parent ||
    parent.issuer !== "api" ||
    !("maintenanceId" in operation) ||
    !operation.maintenanceId ||
    actor.childOperationKey !== request.operationKey ||
    actor.childOperationFingerprint !== fingerprint ||
    actor.requestedDeadlineAt !== request.requestedDeadlineAt ||
    createHash("sha256").update(request.parentAssertion).digest("hex") !== parent.assertionDigest
  )
    throw new ConfigurationMaintenanceControlUnauthorized(
      "Actual API maintenance phase request required",
    );
  const observed = verifyControl(
      installation.publicKey,
      domain,
      readPrivateRecord(local, "configuration-maintenance", `${operation.maintenanceId}.json`),
      ownerSchema,
    ),
    authority = restoreAdmittedControlExecution(installation, observed.plan.prepare),
    owner = read(authority),
    original = owner.plan.apiParent,
    step = owner.plan.steps.find(
      (value) =>
        value.operationKey === request.operationKey && value.operationFingerprint === fingerprint,
    );
  if (
    !step ||
    ![
      "configuration-commit",
      "maintenance-hardlinks",
      "maintenance-recreate",
      "maintenance-handoff",
    ].includes(step.phase) ||
    canonicalJson(step.operation) !== canonicalJson(operation) ||
    actor.apiJobId !== original.apiJobId ||
    actor.parentOperationKey !== original.operationKey ||
    actor.parentFingerprint !== original.fingerprint ||
    actor.parentDeadlineAt !== original.deadlineAt ||
    request.requestedDeadlineAt !== owner.plan.prepare.deadlineAt ||
    owner.receipt.decision?.decision !== "continue" ||
    !owner.apiControls.decide?.receiptDelivery
  )
    throw new ConfigurationMaintenanceControlUnauthorized(
      "Original authorized frozen generation phase required",
    );
  const reservation = owner.plan.reservations.find(
    (value) => value.ordinal === step.ordinal && value.phase === step.phase,
  )!;
  let source = owner.apiControls.steps.find((value) => value.ordinal === step.ordinal),
    freshDispatch: Awaited<ReturnType<typeof issueControlChildPhase>>["dispatchTicket"] | undefined;
  if (!source) {
    if (step.phase === "configuration-commit")
      await verifyFrozenMaintenanceGenerationSource(runtime, authority, request.signal);
    else if (step.phase === "maintenance-hardlinks")
      await verifyFrozenMaintenanceHardlinksSource(runtime, authority, request.signal);
    else if (step.phase === "maintenance-recreate")
      await verifyFrozenMaintenanceRecreateSource(runtime, authority, step.ordinal, request.signal);
    else if (step.phase === "maintenance-handoff")
      await verifyFrozenMaintenanceFollowUpSource(
        runtime,
        authority,
        step.ordinal,
        request.signal,
        "maintenance-handoff",
      );
    else
      throw new ConfigurationMaintenanceControlUnauthorized(
        "Uninstalled frozen maintenance continuation",
      );
    publishConfigurationMaintenanceForwardWitness(authority);
    const lease = restoreConfigurationMaintenancePhaseIssuer(authority, step.phase);
    try {
      if (lookupControlChildPhaseBinding(authority, reservation))
        throw new ConfigurationMaintenanceControlConflict(
          "Attempted frozen phase requires original observation",
        );
      const bound = await bindControlChildPhase(authority, reservation);
      source = configurationMaintenanceStepControlSourceSchema.parse({
        version: 1,
        ordinal: step.ordinal,
        execution: bound.execution,
        apiParent: parent,
        parentAssertion: request.parentAssertion,
        requestedDeadlineAt: request.requestedDeadlineAt,
        receivedAt: Date.now(),
        grant: null,
        canonical: null,
        receiptDelivery: null,
      });
      const retained = source;
      withConfigurationMaintenancePhasePublication(lease, authority, step.phase, () => {
        const current = read(authority);
        if (canonicalJson(current) !== canonicalJson(owner))
          throw new ConfigurationMaintenanceControlConflict("Original frozen phase owner raced");
        const sequence = current.sequence + 1;
        write(authority, {
          ...current,
          sequence,
          receipt: { ...current.receipt, sequence, state: "applying" },
          apiControls: {
            ...current.apiControls,
            steps: [...current.apiControls.steps, retained].sort((a, b) => a.ordinal - b.ordinal),
          },
        });
      });
      const issued = await issueControlChildPhase(authority, {
        phase: step.phase,
        ordinal: step.ordinal,
        lease,
        childPublicKey: controlRolePublicKey(installation, "ops-agent"),
      });
      freshDispatch = issued.dispatchTicket;
      const attempted = lookupControlChildPhaseAttempt(authority, reservation);
      if (
        !attempted ||
        attempted.channel !== "delegation" ||
        attempted.assertion !== issued.assertion
      )
        throw new ConfigurationMaintenanceControlConflict("Original local phase grant required");
      source = configurationMaintenanceStepControlSourceSchema.parse({
        ...retained,
        grant: {
          leaseId: attempted.leaseId,
          delegationId: attempted.delegationId,
          grantDigest: attempted.grantDigest,
        },
      });
      const granted = source;
      withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
        const current = read(authority),
          previous = current.apiControls.steps.find((value) => value.ordinal === step.ordinal);
        if (canonicalJson(previous) !== canonicalJson(retained))
          throw new ConfigurationMaintenanceControlConflict("Original local phase intent raced");
        write(authority, {
          ...current,
          apiControls: {
            ...current.apiControls,
            steps: current.apiControls.steps.map((value) =>
              value.ordinal === step.ordinal ? granted : value,
            ),
          },
        });
      });
    } finally {
      closeArtifactTargetLeaseHandle(lease);
    }
  } else if (
    canonicalJson(source.apiParent) !== canonicalJson(parent) ||
    source.parentAssertion !== request.parentAssertion
  )
    throw new ConfigurationMaintenanceControlConflict("Original local phase request changed");
  const binding = lookupControlChildPhaseBinding(authority, reservation),
    attempted = lookupControlChildPhaseAttempt(authority, reservation);
  if (!source.grant || !binding || !attempted || attempted.channel !== "delegation")
    throw new ConfigurationMaintenanceControlConflict(
      "Original attempted local phase observation required",
    );
  const inspected = inspectArtifactDelegation({
      dataRoot: local.dataRoot,
      installation,
      assertion: attempted.assertion,
    }),
    roleParent = verifiedParentForArtifactDelegation(
      installation,
      attempted.assertion,
      binding.child.execution,
    ),
    assertion = attempted.assertion;
  if (
    canonicalJson(inspected.execution) !== canonicalJson(source.execution) ||
    inspected.kind !== operation.kind ||
    inspected.leaseId !== source.grant.leaseId ||
    inspected.delegationId !== source.grant.delegationId
  )
    throw new ConfigurationMaintenanceControlConflict("Original frozen local admission changed");
  const admission = Object.freeze({
    ...inspected,
    parent: roleParent,
    boundAt: binding.boundAt,
    reservations:
      step.phase === "maintenance-hardlinks" && owner.plan.nestedHardlinks
        ? [owner.plan.nestedHardlinks]
        : step.phase === "maintenance-handoff" && owner.plan.nestedHandoff
          ? [owner.plan.nestedHandoff]
          : [],
    async adopt(execution: ExecutionRef) {
      if (!freshDispatch || canonicalJson(execution) !== canonicalJson(binding.child.execution))
        throw new ConfigurationMaintenanceControlConflict("Attempted frozen phase is lookup-only");
      consumeControlChildDispatch(freshDispatch);
      const peer = verifyRetainedLocalControlPeer(installation, {
        assertion,
        execution,
        kind: operation.kind,
      });
      return adoptArtifactTargetLease({
        dataRoot: local.dataRoot,
        assertion,
        peer,
        execution,
        serviceIds: inspected.serviceIds,
      });
    },
  });
  if (step.phase === "maintenance-recreate")
    frozenRecreateAdmissions.set(admission, {
      operation: canonicalJson(operation),
      operationKey: request.operationKey,
      runtime,
      authority,
      ordinal: step.ordinal,
    });
  return admission;
}
const frozenRecreateAdmissions = new WeakMap<
  object,
  {
    operation: string;
    operationKey: string;
    runtime: OpsRuntime;
    authority: VerifiedExecutionAuthority;
    ordinal: number;
  }
>();
export async function inspectOwnedMaintenanceRecreateAdmission(
  value: unknown,
  operation: OpsOperation,
  operationKey: string,
  signal: AbortSignal,
): Promise<OwnedServiceSnapshot[]> {
  if (!isOwnedMaintenanceRecreateAdmission(value, operation, operationKey))
    throw Error("Actual frozen recreate admission required");
  const fixed = frozenRecreateAdmissions.get(value as object)!;
  await verifyFrozenMaintenanceRecreateSource(
    fixed.runtime,
    fixed.authority,
    fixed.ordinal,
    signal,
  );
  const source = sources.get(fixed.runtime);
  if (!source) throw Error("Actual original source required");
  return inspectOriginalOwnerServices(source, fixed.authority, signal);
}
export function isOwnedMaintenanceRecreateAdmission(
  value: unknown,
  operation: OpsOperation,
  operationKey: string,
) {
  const source =
    value && typeof value === "object" ? frozenRecreateAdmissions.get(value) : undefined;
  return (
    !!source &&
    source.operation === canonicalJson(operation) &&
    source.operationKey === operationKey
  );
}
/** Runtime recheck from the actual borrowed child and original signed owner,
 * never workflow availability, a maintenance UUID or an admission boolean. */
export async function assertOwnedMaintenanceRecreateRuntime(
  runtime: OpsRuntime,
  operation: OpsOperation,
  context: import("./runtime").OpsExecutionContext,
) {
  if (
    (operation.kind !== "service.recreate" && operation.kind !== "service.recreateIsolated") ||
    !operation.maintenanceId ||
    !context.controlAuthority ||
    !context.artifactLease
  )
    throw Error("Actual original borrowed maintenance recreate required");
  const child = executionAuthorityState(context.controlAuthority),
    observed = verifyControl(
      child.installation.installation.publicKey,
      domain,
      readPrivateRecord(
        child.installation,
        "configuration-maintenance",
        `${operation.maintenanceId}.json`,
      ),
      ownerSchema,
    ),
    root = restoreAdmittedControlExecution(child.installation.installation, observed.plan.prepare),
    owner = readOwnedConfigurationMaintenance(root),
    step = owner.plan.steps.find(
      (value) =>
        value.operationKey === child.execution.operationKey &&
        value.operationFingerprint === child.execution.operationFingerprint,
    );
  if (
    !step ||
    !child.origin ||
    canonicalJson(child.origin) !== canonicalJson(owner.origin) ||
    canonicalJson(step.operation) !== canonicalJson(operation)
  )
    throw Error("Frozen borrowed recreate changed");
  await verifyFrozenMaintenanceRecreateSource(runtime, root, step.ordinal, context.signal);
  const source = sources.get(runtime);
  if (!source) throw Error("Actual original source required");
  return inspectOriginalOwnerServices(source, root, context.signal);
}
/** Exact fixed handoff source from its actual borrowed child and signed
 * maintenance owner. No ordinary lifecycle operation can call this adapter. */
export async function assertOwnedMaintenanceHandoffRuntime(
  runtime: OpsRuntime,
  operation: Extract<OpsOperation, { kind: "configurationHandoff.prepare" }>,
  context: import("./runtime").OpsExecutionContext,
) {
  if (!context.controlAuthority || !context.artifactLease)
    throw Error("Actual original borrowed maintenance handoff required");
  assertArtifactTargetLeaseExecution(context.artifactLease, context.execution);
  const child = executionAuthorityState(context.controlAuthority),
    observed = verifyControl(
      child.installation.installation.publicKey,
      domain,
      readPrivateRecord(
        child.installation,
        "configuration-maintenance",
        `${operation.maintenanceId}.json`,
      ),
      ownerSchema,
    ),
    root = restoreAdmittedControlExecution(child.installation.installation, observed.plan.prepare),
    owner = readOwnedConfigurationMaintenance(root),
    step = owner.plan.steps.find(
      (value) =>
        value.operationKey === child.execution.operationKey &&
        value.operationFingerprint === child.execution.operationFingerprint,
    );
  if (
    !step ||
    step.phase !== "maintenance-handoff" ||
    !owner.plan.handoff ||
    !owner.plan.nestedHandoff ||
    !child.origin ||
    canonicalJson(child.origin) !== canonicalJson(owner.origin) ||
    canonicalJson(step.operation) !== canonicalJson(operation) ||
    child.kind !== operation.kind ||
    canonicalJson(child.reservations) !== canonicalJson([owner.plan.nestedHandoff])
  )
    throw Error("Original frozen handoff source changed");
  await verifyFrozenMaintenanceFollowUpSource(
    runtime,
    root,
    step.ordinal,
    context.signal,
    "maintenance-handoff",
  );
  const source = sources.get(runtime);
  if (!source) throw Error("Actual original source required");
  return { root, owner, source };
}
/** Retention capture for the exact already-authorized borrowed generation child.
 * No caller snapshot or maintenance UUID alone can select OLD ownership. */
export async function inspectOwnedMaintenanceGenerationRuntime(
  runtime: OpsRuntime,
  context: import("./runtime").OpsExecutionContext,
  operation: Extract<OpsOperation, { kind: "stack.render" | "vault.apply" }>,
  signal: AbortSignal,
) {
  if (!context.controlAuthority || !context.artifactLease || !operation.maintenanceId)
    throw Error("Actual borrowed generation required");
  const child = executionAuthorityState(context.controlAuthority),
    observed = verifyControl(
      child.installation.installation.publicKey,
      domain,
      readPrivateRecord(
        child.installation,
        "configuration-maintenance",
        `${operation.maintenanceId}.json`,
      ),
      ownerSchema,
    ),
    root = restoreAdmittedControlExecution(child.installation.installation, observed.plan.prepare),
    owner = readOwnedConfigurationMaintenance(root),
    step = owner.plan.steps.find((value) => value.operationKey === child.execution.operationKey);
  if (
    !step ||
    step.phase !== "configuration-commit" ||
    step.operationFingerprint !== child.execution.operationFingerprint ||
    canonicalJson(step.operation) !== canonicalJson(operation) ||
    !child.origin ||
    canonicalJson(child.origin) !== canonicalJson(owner.origin) ||
    owner.receipt.decision?.decision !== "continue" ||
    !owner.apiControls.decide?.receiptDelivery ||
    owner.receipt.generation !== "not_started"
  )
    throw Error("Original authorized generation source changed");
  if (!owner.coordinatorPull && !owner.stagedCoordinatorProvenance) return undefined;
  // The resolver is the same literal production instance registered for this owner runtime.
  const source = sources.get(runtime);
  if (!source) throw Error("Original production generation source unavailable");
  const services = await inspectOriginalOwnerServices(source, root, signal),
    ordinary = await source.ownedServices.inspectInventory?.(signal);
  if (!ordinary || ordinary.unverifiedServiceIds.some((id) => id !== "data-manager"))
    throw Error("Original generation inventory unavailable");
  return {
    services,
    observedContainerIds: ordinary.observedContainerIds,
    unverifiedServiceIds: [],
  };
}
/** Read-only eligibility from the actual MAC packet and closed existing
 * producer. It grants no generation child, decision or publication authority. */
export async function assertPlannedCoordinatorConfigurationWrite(
  runtime: OpsRuntime,
  operation: Extract<OpsOperation, { kind: "configuration.hardlinks.preview" }>,
) {
  const source = sources.get(runtime);
  if (!source?.candidateSource) throw Error("Actual planned coordinator source required");
  const candidate = await readConfigurationCandidate(source.candidateSource, operation.candidateId),
    original = candidate.operation,
    record = candidate.record;
  if (
    !["stack.render", "vault.apply"].includes(original.kind) ||
    !("revisionId" in original) ||
    !("expectedCurrentRevisionId" in original) ||
    !("expectedSourceRevision" in original) ||
    !("coordinatorMode" in original) ||
    original.revisionId !== operation.revisionId ||
    original.expectedCurrentRevisionId !== operation.expectedCurrentRevisionId ||
    original.expectedSourceRevision !== operation.expectedSourceRevision ||
    original.coordinatorMode !== operation.coordinatorMode ||
    record.candidateId !== operation.candidateId ||
    !record.maintenanceId ||
    !record.prepareOperationKey ||
    (canonicalJson(record.affectedServiceIds) !== '["data-manager"]' &&
      !(
        record.privateIntegrationReload?.stagedMigration &&
        record.affectedServiceIds.includes("data-manager")
      ))
  )
    throw Error("Planned coordinator identity changed");
  if (record.privateCoordinatorLifecycle) {
    renderCoordinatorCandidate(candidate, await source.loadAuthority(), source.infraDir);
    return;
  }
  const overlay = record.privateOverlay as { purpose?: unknown; changes?: unknown } | null;
  if (record.privateIntegrationReload?.stagedMigration) {
    if (
      original.kind !== "stack.render" ||
      !overlay ||
      overlay.purpose !== "migration" ||
      !Array.isArray(overlay.changes) ||
      overlay.changes.length > 512 ||
      !["integration-reload", "platform-apply"].includes(record.apiFollowUp ?? "") ||
      overlay.changes.some(
        (change) =>
          !change ||
          typeof change !== "object" ||
          ![
            "service-config",
            "integration-config",
            "service-secret",
            "integration-secret",
            "integration-binding",
            "platform",
            "selection",
          ].includes(change.kind),
      )
    )
      throw Error("Fixed staged migration producer required");
    const managed = overlay.changes.find(
      (change) =>
        change.kind === "service-secret" &&
        change.serviceId === "data-manager" &&
        change.key === "TRANSITOUS_API_KEYS",
    );
    if (
      managed &&
      (record.privateIntegrationReload.stagedMigration.kind !== "credentials" ||
        managed.action !== "set" ||
        candidate.payload.serviceSecrets.find((entry) => entry.serviceId === "data-manager")?.values
          .TRANSITOUS_API_KEYS !== managed.value ||
        !candidate.payload.transitCredentialsRevision)
    )
      throw Error("Original managed migration map required");
    return;
  }

  if (
    original.kind !== "vault.apply" ||
    original.serviceId !== "data-manager" ||
    record.apiFollowUp !== "service-apply" ||
    !overlay ||
    typeof overlay !== "object" ||
    Array.isArray(overlay) ||
    !["service-secret", "transit-credentials"].includes(String(overlay.purpose)) ||
    !Array.isArray(overlay.changes) ||
    !overlay.changes.length ||
    !overlay.changes.every(
      (change) =>
        change &&
        typeof change === "object" &&
        !Array.isArray(change) &&
        change.kind === "service-secret" &&
        change.serviceId === "data-manager",
    )
  )
    throw Error("Fixed planned DM recreation producer required");
  if (overlay.purpose === "transit-credentials") {
    const change = overlay.changes[0] as Record<string, unknown> | undefined;
    if (
      original.coordinatorMode !== "require-running" ||
      overlay.changes.length !== 1 ||
      change?.key !== "TRANSITOUS_API_KEYS" ||
      change.action !== "set" ||
      typeof change.value !== "string" ||
      candidate.payload.serviceSecrets.find((entry) => entry.serviceId === "data-manager")?.values
        .TRANSITOUS_API_KEYS !== change.value ||
      !candidate.payload.transitCredentialsRevision
    )
      throw Error("Fixed managed transit credential producer required");
  } else if (
    overlay.changes.some(
      (change) => (change as Record<string, unknown>).key === "TRANSITOUS_API_KEYS",
    )
  ) {
    throw Error("Managed transit credential producer required");
  }
}
/** Actual publication is stricter than the read-only planned eligibility. */
export async function assertOwnedCoordinatorConfigurationWrite(
  runtime: OpsRuntime,
  context: import("./runtime").OpsExecutionContext,
  operation: Extract<OpsOperation, { kind: "stack.render" | "vault.apply" }>,
  signal: AbortSignal,
) {
  await inspectOwnedMaintenanceGenerationRuntime(runtime, context, operation, signal);
  if (!context.controlAuthority || !operation.maintenanceId)
    throw Error("Nominal coordinator generation required");
  const child = executionAuthorityState(context.controlAuthority),
    observed = verifyControl(
      child.installation.installation.publicKey,
      domain,
      readPrivateRecord(
        child.installation,
        "configuration-maintenance",
        `${operation.maintenanceId}.json`,
      ),
      ownerSchema,
    ),
    root = restoreAdmittedControlExecution(child.installation.installation, observed.plan.prepare),
    owner = readOwnedConfigurationMaintenance(root);
  if (
    !owner.plan.coordinatorImage ||
    !owner.plan.steps.some(
      (step) =>
        step.phase === "maintenance-recreate" &&
        "serviceId" in step.operation &&
        step.operation.serviceId === "data-manager",
    )
  )
    throw Error("Original frozen DM recreation required");
}
/** The outer digest is a mandatory observation checksum ONLY. Compare against
 * the ACTUAL owner under its writer BEFORE the first control intent/sequence
 * mutation. Accepted duplicates use the retained original body/observation. */
export function retainConfigurationMaintenanceSettleControl(
  value: ConfigurationMaintenanceControlOwner,
  operation: ConfigurationMaintenanceSettle,
  execution: ExecutionRef,
  request: {
    admittedAt: number;
    requestedDeadlineAt: number;
    parentAssertion: string;
    requestVersion: 2;
    deploymentBudgetMs: number;
  },
): void {
  const source = configurationMaintenanceControlOwnerState(
      value,
      operation,
      execution.operationKey,
    ),
    authority = source.authority,
    parent = source.parent;
  if (
    parent.issuer !== "api" ||
    execution.executor !== "ops-agent" ||
    execution.principal !== "api" ||
    execution.operationFingerprint !== source.operationFingerprint ||
    execution.fingerprint !==
      executionFingerprint({
        kind: operation.kind,
        operationFingerprint: source.operationFingerprint,
        deadlineAt: execution.deadlineAt,
        parent,
      }) ||
    request.requestedDeadlineAt !== source.requestedDeadlineAt ||
    execution.deadlineAt <= request.admittedAt ||
    !Number.isSafeInteger(request.deploymentBudgetMs) ||
    request.deploymentBudgetMs < 1 ||
    request.deploymentBudgetMs > 60000 ||
    execution.deadlineAt !==
      Math.min(request.requestedDeadlineAt, request.admittedAt + request.deploymentBudgetMs) ||
    createHash("sha256").update(request.parentAssertion).digest("hex") !== parent.assertionDigest
  )
    throw new ConfigurationMaintenanceControlUnauthorized(
      "Actual original settlement request required",
    );
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
      const owner = read(authority),
        previous = owner.apiControls.settle;
      if (previous) {
        if (
          canonicalJson(previous.operation) !== canonicalJson(operation) ||
          canonicalJson(previous.execution) !== canonicalJson(execution) ||
          previous.admittedAt !== request.admittedAt ||
          previous.requestedDeadlineAt !== request.requestedDeadlineAt ||
          previous.parentAssertion !== request.parentAssertion ||
          canonicalJson(previous.apiParent) !== canonicalJson(parent) ||
          previous.requestVersion !== request.requestVersion ||
          previous.deploymentBudgetMs !== request.deploymentBudgetMs
        )
          throw new ConfigurationMaintenanceControlConflict(
            "Original accepted settlement request changed",
          );
        return;
      }
      const acceptedAt = Date.now();
      if (
        owner.final ||
        owner.inspection ||
        !owner.preparedFence ||
        !owner.apiControls.decide?.receiptDelivery ||
        owner.receipt.decision?.decisionId !== operation.decisionId ||
        owner.sequence !== operation.expectedSequence ||
        acceptedAt >= execution.deadlineAt ||
        !timingSafeEqual(
          Buffer.from(operation.evidenceDigest, "hex"),
          Buffer.from(configurationMaintenanceSettleRequestDigest(owner.receipt), "hex"),
        )
      )
        throw new ConfigurationMaintenanceControlConflict(
          "Original settlement request observation conflict",
        );
      const retained = configurationMaintenanceSettleControlSourceSchema.parse({
        version: 1,
        operation,
        execution,
        apiParent: parent,
        parentAssertion: request.parentAssertion,
        admittedAt: request.admittedAt,
        requestedDeadlineAt: request.requestedDeadlineAt,
        acceptedAt,
        requestVersion: request.requestVersion,
        deploymentBudgetMs: request.deploymentBudgetMs,
        checkedSequence: owner.sequence,
        requestEvidenceDigest: operation.evidenceDigest,
        completedAt: null,
        result: null,
        canonicalDigest: null,
        receiptDelivery: null,
      });
      if (Buffer.byteLength(canonicalJson(retained)) > 8192)
        throw new ConfigurationMaintenanceControlConflict(
          "Original settlement control capacity exceeded",
        );
      const sequence = owner.sequence + 1;
      write(authority, {
        ...owner,
        sequence,
        receipt: { ...owner.receipt, sequence },
        apiControls: { ...owner.apiControls, settle: retained },
      });
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
type DecisionSource = NonNullable<ConfigurationMaintenanceOwnerRecord["apiControls"]["decide"]>;
function decisionReceipt(
  owner: ConfigurationMaintenanceOwnerRecord,
  source: Pick<DecisionSource, "result">,
): ConfigurationMaintenanceReceipt {
  return { ...owner.receipt, ...source.result };
}
function decisionStatus(
  owner: ConfigurationMaintenanceOwnerRecord,
  source: Pick<DecisionSource, "execution" | "admittedAt" | "acceptedAt" | "operation" | "result">,
): OpsJobStatus {
  return {
    version: 2,
    admittedAt: source.admittedAt,
    deadlineAt: source.execution.deadlineAt,
    fingerprint: source.execution.fingerprint,
    operationId: source.execution.executionId,
    operationKey: source.execution.operationKey,
    kind: "configurationMaintenance.decide",
    resourceId: opsResourceId(source.operation),
    state: "succeeded",
    submittedAt: new Date(source.admittedAt).toISOString(),
    updatedAt: new Date(source.acceptedAt).toISOString(),
    result: decisionReceipt(owner, source),
  };
}
/** Actual API HMAC admission -> original held owner -> ONE metadata CAS. The
 * request execution is correlation only; it receives no origin, target lease,
 * grant, ordinary child or forward authority. Abandon cannot issue effects. */
export function retainConfigurationMaintenanceDecisionControl(
  value: ConfigurationMaintenanceControlOwner,
  operation: ConfigurationMaintenanceDecision,
  execution: ExecutionRef,
  request: {
    admittedAt: number;
    requestedDeadlineAt: number;
    parentAssertion: string;
    requestVersion: 2;
    deploymentBudgetMs: number;
  },
  continueObservation?: MaintenanceContinueObservation,
): ConfigurationMaintenanceReceipt {
  const source = configurationMaintenanceControlOwnerState(
      value,
      operation,
      execution.operationKey,
    ),
    authority = source.authority,
    parent = source.parent;
  if (
    parent.issuer !== "api" ||
    execution.executor !== "ops-agent" ||
    execution.principal !== "api" ||
    execution.operationFingerprint !== source.operationFingerprint ||
    execution.fingerprint !==
      executionFingerprint({
        kind: operation.kind,
        operationFingerprint: source.operationFingerprint,
        deadlineAt: execution.deadlineAt,
        parent,
      }) ||
    request.requestedDeadlineAt !== source.requestedDeadlineAt ||
    execution.deadlineAt <= request.admittedAt ||
    !Number.isSafeInteger(request.deploymentBudgetMs) ||
    request.deploymentBudgetMs < 1 ||
    request.deploymentBudgetMs > 60000 ||
    execution.deadlineAt !==
      Math.min(
        request.requestedDeadlineAt,
        operation.decision === "continue" ? parent.deadlineAt : Infinity,
        request.admittedAt + request.deploymentBudgetMs,
      ) ||
    createHash("sha256").update(request.parentAssertion).digest("hex") !== parent.assertionDigest
  )
    throw new ConfigurationMaintenanceControlUnauthorized(
      "Actual fixed API decision request required",
    );
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    const publish = () => {
      const owner = read(authority),
        previous = owner.apiControls.decide;
      if (previous) {
        if (
          canonicalJson(previous.operation) !== canonicalJson(operation) ||
          canonicalJson(previous.execution) !== canonicalJson(execution) ||
          previous.admittedAt !== request.admittedAt ||
          previous.requestedDeadlineAt !== request.requestedDeadlineAt ||
          previous.requestVersion !== request.requestVersion ||
          previous.deploymentBudgetMs !== request.deploymentBudgetMs ||
          previous.parentAssertion !== request.parentAssertion ||
          canonicalJson(previous.apiParent) !== canonicalJson(parent) ||
          previous.canonicalDigest !== controlTerminalReceiptDigest(decisionStatus(owner, previous))
        )
          throw new ConfigurationMaintenanceControlConflict("Original decision control changed");
        return decisionReceipt(owner, previous);
      }
      const acceptedAt = Date.now();
      if (
        acceptedAt >= execution.deadlineAt ||
        !owner.preparedFence ||
        owner.receipt.state !== "prepared" ||
        owner.receipt.decision !== null ||
        owner.receipt.dmFence?.state !== "prepared" ||
        owner.receipt.generation !== "not_started" ||
        owner.receipt.followUp !== "not_started" ||
        owner.sequence !== operation.expectedSequence
      )
        throw new ConfigurationMaintenanceControlConflict(
          "Original unused prepared decision source required",
        );
      if (operation.decision === "continue")
        consumeMaintenanceContinueObservation(continueObservation, authority);
      const next = owner.sequence + 1,
        receipt: ConfigurationMaintenanceReceipt = {
          ...owner.receipt,
          sequence: next,
          state: "authorized",
          preflight: operation.decision === "continue" ? "current" : "unavailable",
          decision: {
            decisionId: operation.decisionId,
            decision: operation.decision,
            checkpointVersion: operation.checkpointVersion,
            checkpointDigest: operation.checkpointDigest,
          },
        },
        pending = {
          version: 1 as const,
          operation,
          execution,
          apiParent: parent,
          parentAssertion: request.parentAssertion,
          admittedAt: request.admittedAt,
          requestedDeadlineAt: request.requestedDeadlineAt,
          acceptedAt,
          result: configurationMaintenanceControlSnapshotSchema.parse({
            preflight: receipt.preflight,
            sequence: receipt.sequence,
            state: receipt.state,
            decision: receipt.decision,
            dmFence: receipt.dmFence,
            generation: receipt.generation,
            appliedRevisionId: receipt.appliedRevisionId,
            followUp: receipt.followUp,
          }),
          requestVersion: request.requestVersion,
          deploymentBudgetMs: request.deploymentBudgetMs,
          receiptDelivery: null,
        },
        canonicalDigest = controlTerminalReceiptDigest(decisionStatus(owner, pending)),
        commitment = signControl(
          executionAuthorityState(authority).installation.privateKey,
          configurationMaintenanceDecisionCommitmentDomain,
          configurationMaintenanceDecisionCommitmentPayload(owner, { ...pending, canonicalDigest }),
        ),
        retained = configurationMaintenanceDecisionSourceSchema.parse({
          ...pending,
          canonicalDigest,
          commitment,
        });
      if (Buffer.byteLength(canonicalJson(retained)) > 8192)
        throw new ConfigurationMaintenanceControlConflict(
          "Original decision control capacity exceeded",
        );
      write(authority, {
        ...owner,
        sequence: next,
        receipt,
        apiControls: { ...owner.apiControls, decide: retained },
      });
      return receipt;
    };
    return operation.decision === "continue"
      ? withConfigurationMaintenanceDecisionPublication(lease, authority, publish)
      : withConfigurationMaintenanceOwnerObservation(lease, authority, publish);
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
export function inspectConfigurationMaintenanceDecisionControl(
  value: ConfigurationMaintenanceControlOwner,
  operation: ConfigurationMaintenanceDecision,
  execution: ExecutionRef,
) {
  const source = configurationMaintenanceControlOwnerState(
      value,
      operation,
      execution.operationKey,
    ),
    owner = read(source.authority),
    retained = owner.apiControls.decide;
  if (
    !retained ||
    canonicalJson(retained.operation) !== canonicalJson(operation) ||
    canonicalJson(retained.execution) !== canonicalJson(execution) ||
    retained.canonicalDigest !== controlTerminalReceiptDigest(decisionStatus(owner, retained))
  )
    throw new ConfigurationMaintenanceControlConflict(
      "Original accepted decision control required",
    );
  return {
    receipt: decisionReceipt(owner, retained),
    status: decisionStatus(owner, retained),
    terminalAt: retained.acceptedAt,
  };
}
type SettleSource = NonNullable<ConfigurationMaintenanceOwnerRecord["apiControls"]["settle"]>;
function settleStatus(
  owner: ConfigurationMaintenanceOwnerRecord,
  source: SettleSource,
): OpsJobStatus {
  if (!source.result || source.completedAt === null)
    return {
      version: 2,
      admittedAt: source.admittedAt,
      deadlineAt: source.execution.deadlineAt,
      fingerprint: source.execution.fingerprint,
      operationId: source.execution.executionId,
      operationKey: source.execution.operationKey,
      kind: "configurationMaintenance.settle",
      resourceId: opsResourceId(source.operation),
      state: "failed",
      errorClass: "recovery_required",
      submittedAt: new Date(source.admittedAt).toISOString(),
      updatedAt: new Date(source.acceptedAt).toISOString(),
    };
  return {
    version: 2,
    admittedAt: source.admittedAt,
    deadlineAt: source.execution.deadlineAt,
    fingerprint: source.execution.fingerprint,
    operationId: source.execution.executionId,
    operationKey: source.execution.operationKey,
    kind: "configurationMaintenance.settle",
    resourceId: opsResourceId(source.operation),
    state: "succeeded",
    submittedAt: new Date(source.admittedAt).toISOString(),
    updatedAt: new Date(source.completedAt).toISOString(),
    result: { ...owner.receipt, ...source.result },
  };
}
/** Publication follows the original immutable final, actual DM/ACK closure and
 * retained physical release. Its time is that release's original source time. */
export function completeConfigurationMaintenanceSettleControl(
  value: ConfigurationMaintenanceControlOwner,
  operation: ConfigurationMaintenanceSettle,
  execution: ExecutionRef,
): ConfigurationMaintenanceReceipt {
  const source = configurationMaintenanceControlOwnerState(
      value,
      operation,
      execution.operationKey,
    ),
    owner = read(source.authority),
    retained = owner.apiControls.settle;
  if (
    !retained ||
    canonicalJson(retained.operation) !== canonicalJson(operation) ||
    canonicalJson(retained.execution) !== canonicalJson(execution)
  )
    throw Error("Original settle completion binding changed");
  return completeOwnedConfigurationMaintenanceSettleControl(source.authority);
}
/** Publication-only recovery has no live API-parent/dispatch capability. */
function completeOwnedConfigurationMaintenanceSettleControl(
  authority: VerifiedExecutionAuthority,
): ConfigurationMaintenanceReceipt {
  const released = verifyRetainedArtifactTargetRootRelease(authority);
  restoreOwnedMaintenanceFinal(authority);
  assertConfigurationMaintenanceRootClosure(authority);
  return withPrivateEffectWriter(executionAuthorityState(authority), () => {
    const owner = read(authority),
      retained = owner.apiControls.settle;
    if (!retained) throw Error("Original accepted settle intent required");
    const completed = configurationMaintenanceSettleCompletion(owner, released.releasedAt);
    if (retained.result) {
      if (retained.canonicalDigest !== controlTerminalReceiptDigest(settleStatus(owner, retained)))
        throw Error("Original settle completion changed");
      return { ...owner.receipt, ...retained.result };
    }
    write(authority, completed);
    return { ...owner.receipt, ...completed.apiControls.settle!.result };
  });
}
/** Observation-only completion of the ORIGINAL accepted control. The callee
 * requires its actual full closure and retained physical release timestamp. */
export function completeObservedConfigurationMaintenanceSettlement(
  authority: VerifiedExecutionAuthority,
): ConfigurationMaintenanceReceipt {
  return completeOwnedConfigurationMaintenanceSettleControl(authority);
}
export function inspectConfigurationMaintenanceSettleControl(
  value: ConfigurationMaintenanceControlOwner,
  operation: ConfigurationMaintenanceSettle,
  execution: ExecutionRef,
) {
  const source = configurationMaintenanceControlOwnerState(
      value,
      operation,
      execution.operationKey,
    ),
    owner = read(source.authority),
    retained = owner.apiControls.settle;
  if (
    !retained?.result ||
    retained.completedAt === null ||
    canonicalJson(retained.operation) !== canonicalJson(operation) ||
    canonicalJson(retained.execution) !== canonicalJson(execution) ||
    retained.canonicalDigest !== controlTerminalReceiptDigest(settleStatus(owner, retained))
  )
    throw Error("Original settle canonical source required");
  restoreOwnedMaintenanceFinal(source.authority);
  assertConfigurationMaintenanceRootClosure(source.authority);
  if (verifyRetainedArtifactTargetRootRelease(source.authority).releasedAt !== retained.completedAt)
    throw Error("Original settle completion time changed");
  return {
    receipt: { ...owner.receipt, ...retained.result },
    status: settleStatus(owner, retained),
    terminalAt: retained.completedAt!,
  };
}
/** An accepted intent without actual final completion is UNKNOWN. This fixed
 * projection carries its original admission/acceptance times and no canonical
 * completion or delivery authority. It never inspects again or runs effects. */
export function inspectConfigurationMaintenanceSettleRecovery(
  value: ConfigurationMaintenanceControlOwner,
  operation: ConfigurationMaintenanceSettle,
  execution: ExecutionRef,
): OpsJobStatus {
  const source = configurationMaintenanceControlOwnerState(
      value,
      operation,
      execution.operationKey,
    ),
    owner = read(source.authority),
    retained = owner.apiControls.settle;
  if (
    !retained ||
    retained.result ||
    retained.canonicalDigest ||
    retained.completedAt !== null ||
    retained.receiptDelivery ||
    canonicalJson(retained.operation) !== canonicalJson(operation) ||
    canonicalJson(retained.execution) !== canonicalJson(execution)
  )
    throw Error("Original unresolved settlement intent required");
  return settleStatus(owner, retained);
}
/** Fixed runtime publication AFTER the child's actual private canonical and
 * physical settlement. A supplied status is only that private tuple's exact
 * preimage; it cannot authorize success, containment or another phase. */
export function recordOwnedConfigurationMaintenanceStepTerminal(
  installation: ControlInstallation,
  operation: OpsOperation,
  execution: ExecutionRef,
  status: OpsJobStatus,
  terminalAt: number,
): void {
  if (!("maintenanceId" in operation) || !operation.maintenanceId)
    throw Error("Original maintenance step terminal required");
  const local = installationState(installation),
    child = restoreAdmittedControlExecution(installation, execution),
    childState = executionAuthorityState(child),
    admission = readPrivateRecord(local, "executions", `${execution.operationKey}.json`, 65536) as {
      payload?: { operation?: unknown };
    },
    observed = verifyControl(
      installation.publicKey,
      domain,
      readPrivateRecord(local, "configuration-maintenance", `${operation.maintenanceId}.json`),
      ownerSchema,
    ),
    authority = restoreAdmittedControlExecution(installation, observed.plan.prepare),
    owner = read(authority),
    source = owner.apiControls.steps.find(
      (value) => value.execution.operationKey === execution.operationKey,
    );
  if (
    !source ||
    canonicalJson(admission.payload?.operation) !== canonicalJson(operation) ||
    canonicalJson(source.execution) !== canonicalJson(execution) ||
    childState.kind !== operation.kind
  )
    throw Error("Original phase terminal admission changed");
  const verified = verifyConfigurationMaintenanceChildTerminal(
      authority,
      source.ordinal,
      status,
      terminalAt,
    ),
    proof = configurationMaintenanceChildState(verified, authority),
    lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    const physical = inspectArtifactTargetLeaseChildSettlement(lease, execution);
    const handoff = owner.plan.steps[source.ordinal]?.phase === "maintenance-handoff";
    if (handoff) verifyControlPreparedTerminal(local, execution);
    else if (!physical || canonicalJson(physical) !== canonicalJson(proof.settlement))
      throw Error("Original phase physical settlement unavailable");
    withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
      const current = read(authority),
        actual = current.apiControls.steps.find((value) => value.ordinal === source.ordinal),
        canonical = {
          status: proof.status,
          terminalDigest: proof.terminalDigest,
          terminalAt: proof.terminalAt,
          effectSettlementDigest: proof.effectSettlementDigest,
        };
      if (!actual || canonicalJson(actual.execution) !== canonicalJson(execution))
        throw Error("Original phase terminal owner changed");
      if (actual.canonical) {
        if (canonicalJson(actual.canonical) !== canonicalJson(canonical))
          throw Error("Original phase canonical tuple changed");
        return;
      }
      const steps = current.apiControls.steps.map((value) =>
          value.ordinal === source.ordinal ? { ...value, canonical } : value,
        ),
        sequence = current.sequence + 1,
        complete =
          !current.plan.handoff &&
          current.plan.steps.every((step) =>
            steps.some((value) => value.ordinal === step.ordinal && value.canonical !== null),
          ),
        generation = current.plan.steps[source.ordinal]!.phase === "configuration-commit",
        notCommitted =
          generation &&
          (proof.status.result as { outcome?: string } | undefined)?.outcome === "not_committed";
      write(authority, {
        ...current,
        sequence,
        apiControls: { ...current.apiControls, steps },
        receipt: {
          ...current.receipt,
          sequence,
          state: ["authorized", "applying"].includes(current.receipt.state)
            ? "applying"
            : current.receipt.state,
          ...(generation
            ? {
                generation: notCommitted ? "not_committed" : "committed",
                appliedRevisionId: notCommitted ? null : current.plan.operation.revisionId,
              }
            : {}),
          ...(handoff
            ? { followUp: "unknown" }
            : notCommitted
              ? { followUp: "contained" }
              : complete
                ? { followUp: "complete" }
                : {}),
        },
      });
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
/** API durable-copy ACK belongs to the original request HMAC, while the
 * effect's execution parent is the original ops root. Neither is substituted. */
export function acknowledgeConfigurationMaintenanceStep(
  installation: ControlInstallation,
  operation: Extract<OpsOperation, { kind: "controlRetention.acknowledge" }>,
  token: string,
) {
  const local = installationState(installation),
    rootRaw = readPrivateRecord(local, "executions", `${operation.originRootKey}.json`, 65536) as {
      payload?: { execution?: ExecutionRef };
    },
    authority = restoreAdmittedControlExecution(
      installation,
      executionRefSchema.parse(rootRaw.payload?.execution),
    ),
    owner = read(authority),
    source = owner.apiControls.steps.find(
      (value) => value.execution.operationKey === operation.operationKey,
    ),
    proof = verifyApiRetentionProof(token, operation.proof);
  if (
    !source?.canonical ||
    !source.grant ||
    source.apiParent.issuer !== "api" ||
    operation.originRootKey !== owner.plan.prepare.operationKey ||
    operation.fingerprint !== source.execution.fingerprint ||
    operation.terminalDigest !== source.canonical.terminalDigest ||
    proof.apiJobId !== source.apiParent.apiJobId ||
    proof.originalApiOwnerVersion !== source.apiParent.apiOwnerVersion ||
    proof.attemptId !== source.apiParent.attemptId ||
    proof.operationKey !== source.execution.operationKey ||
    proof.fingerprint !== source.execution.fingerprint ||
    proof.terminalDigest !== source.canonical.terminalDigest ||
    proof.checkpointOwnerVersion < proof.originalApiOwnerVersion
  )
    throw Error("Actual original phase canonical copy required");
  const verified = verifyConfigurationMaintenanceChildTerminal(
      authority,
      source.ordinal,
      source.canonical.status,
      source.canonical.terminalAt,
    ),
    actual = configurationMaintenanceChildState(verified, authority),
    lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    const physical = inspectArtifactTargetLeaseChildSettlement(lease, source.execution);
    if (owner.plan.steps[source.ordinal]?.phase === "maintenance-handoff")
      verifyControlPreparedTerminal(local, source.execution);
    else if (!physical || canonicalJson(physical) !== canonicalJson(actual.settlement))
      throw Error("Original copied phase settlement unavailable");
    return withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
      const current = read(authority),
        retained = current.apiControls.steps.find((value) => value.ordinal === source.ordinal),
        copy = {
          terminalCopyId: proof.terminalCopyId,
          checkpointOwnerVersion: proof.checkpointOwnerVersion,
          proofDigest: controlDigest(proof),
        };
      if (!retained || canonicalJson(retained.canonical) !== canonicalJson(source.canonical))
        throw Error("Original copied phase source changed");
      if (retained.receiptDelivery) {
        if (canonicalJson(retained.receiptDelivery) !== canonicalJson(copy))
          throw Error("Original phase copy changed");
      } else
        write(authority, {
          ...current,
          apiControls: {
            ...current.apiControls,
            steps: current.apiControls.steps.map((value) =>
              value.ordinal === source.ordinal ? { ...value, receiptDelivery: copy } : value,
            ),
          },
        });
      return { acknowledged: true as const };
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
/** Recover only actual indexed, pinned-role private owner sources. This fixed
 * namespace has at most one owner per retained root family. No public job,
 * current desired state, elapsed clock or missing lookup supplies a result. */
export function restoreConfigurationMaintenanceControlJournal(
  installation: ControlInstallation,
): PersistedOpsJob[] {
  const local = installationState(installation);
  if (installation.role !== "ops-agent" || local.fixedChildId)
    throw new ConfigurationMaintenanceControlUnauthorized("Original host owner required");
  let directory: ReturnType<typeof local.privateRoot.directory>;
  try {
    directory = local.privateRoot.directory("configuration-maintenance");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let names: string[];
  try {
    names = directory.listBounded(CONTROL_RETENTION_LIMITS.familiesPerRole + 5);
  } finally {
    directory.close();
  }
  const records: PersistedOpsJob[] = [],
    keys = new Set<string>(),
    ids = new Set<string>();
  for (const name of names.sort()) {
    if (
      [
        ".retention-count",
        ".retention-highwater",
        ".retention-transaction",
        ".retention-writer",
      ].includes(name)
    )
      continue;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(name)
    )
      throw new ConfigurationMaintenanceControlConflict("Unexpected original owner record");
    const observed = verifyControl(
        installation.publicKey,
        domain,
        readPrivateRecord(local, "configuration-maintenance", name),
        ownerSchema,
      ),
      authority = restoreAdmittedControlExecution(installation, observed.plan.prepare);
    let owner: ConfigurationMaintenanceOwnerRecord;
    try {
      owner = read(authority);
    } catch {
      // A failed original rename may leave the already-indexed completion
      // preimage ahead of its old physical owner. Only that exact preimage is
      // repairable; all other mismatches remain unavailable.
      repairIndexedConfigurationMaintenanceSettleCompletion(authority);
      owner = read(authority);
    }
    if (owner.apiControls.settle?.result === null && owner.receipt.state === "settled") {
      completeOwnedConfigurationMaintenanceSettleControl(authority);
      owner = read(authority);
    }
    if (name !== `${owner.plan.operation.maintenanceId}.json`)
      throw new ConfigurationMaintenanceControlConflict("Original owner address changed");
    for (const source of [owner.apiControls.decide, owner.apiControls.settle]) {
      if (!source) continue;
      const status =
        source.operation.kind === "configurationMaintenance.decide"
          ? decisionStatus(owner, source as DecisionSource)
          : settleStatus(owner, source as SettleSource);
      const unresolved =
        source.operation.kind === "configurationMaintenance.settle" && source.result === null;
      if (!unresolved && source.canonicalDigest !== controlTerminalReceiptDigest(status))
        throw Error("Original control canonical source changed");
      if (source.operation.kind === "configurationMaintenance.settle" && !unresolved) {
        restoreOwnedMaintenanceFinal(authority);
        assertConfigurationMaintenanceRootClosure(authority);
        verifyRetainedArtifactTargetRootRelease(authority);
      }
      if (keys.has(source.execution.operationKey) || ids.has(source.execution.executionId))
        throw new ConfigurationMaintenanceControlConflict("Duplicate original control identity");
      keys.add(source.execution.operationKey);
      ids.add(source.execution.executionId);
      records.push({
        executionVersion: 2,
        requestVersion: source.requestVersion,
        admittedAt: source.admittedAt,
        deadlineAt: source.execution.deadlineAt,
        operationFingerprint: source.execution.operationFingerprint,
        requestedDeadlineAt: source.requestedDeadlineAt,
        deploymentBudgetMs: source.deploymentBudgetMs,
        parent: source.apiParent,
        role: "api",
        operation: source.operation,
        operationId: source.execution.executionId,
        operationKey: source.execution.operationKey,
        fingerprint: source.execution.fingerprint,
        resourceId: opsResourceId(source.operation),
        state: status.state,
        submittedAt: status.submittedAt,
        updatedAt: status.updatedAt,
        ...(unresolved
          ? { errorClass: "recovery_required" as const }
          : { result: status.result, terminalAt: status.updatedAt }),
      });
    }
  }
  return records;
}
/** Copy-before-ACK for the original owner's metadata control, not an invented
 * ordinary family execution. The API proof must name the actual accepted
 * request/parent and its exact immutable private canonical source. */
export function acknowledgeConfigurationMaintenanceControl(
  installation: ControlInstallation,
  operation: Extract<OpsOperation, { kind: "controlRetention.acknowledge" }>,
  token: string,
) {
  const local = installationState(installation);
  if (
    installation.role !== "ops-agent" ||
    local.fixedChildId ||
    operation.originRootKey === operation.operationKey
  )
    throw new ConfigurationMaintenanceControlUnauthorized(
      "Original maintenance control receipt required",
    );
  const admitted = readPrivateRecord(
      local,
      "executions",
      `${operation.originRootKey}.json`,
      65536,
    ) as { payload?: { operation?: unknown; execution?: ExecutionRef } },
    prepare = configurationMaintenancePrepareSchema.parse(admitted.payload?.operation),
    authority = restoreAdmittedControlExecution(
      installation,
      executionRefSchema.parse(admitted.payload?.execution),
    ),
    proof = verifyApiRetentionProof(token, operation.proof);
  const publish = () => {
    const owner = read(authority),
      slot =
        owner.apiControls.settle?.execution.operationKey === operation.operationKey
          ? "settle"
          : "decide",
      source = owner.apiControls[slot];
    if (
      !source ||
      source.apiParent.issuer !== "api" ||
      owner.plan.operation.maintenanceId !== prepare.maintenanceId ||
      owner.plan.prepare.operationKey !== operation.originRootKey ||
      source.execution.operationKey !== operation.operationKey ||
      source.execution.fingerprint !== operation.fingerprint ||
      source.canonicalDigest !== operation.terminalDigest ||
      source.canonicalDigest !==
        controlTerminalReceiptDigest(
          source.operation.kind === "configurationMaintenance.decide"
            ? decisionStatus(owner, source as DecisionSource)
            : settleStatus(owner, source as SettleSource),
        ) ||
      createHash("sha256").update(source.parentAssertion).digest("hex") !==
        source.apiParent.assertionDigest ||
      proof.apiJobId !== source.apiParent.apiJobId ||
      proof.originalApiOwnerVersion !== source.apiParent.apiOwnerVersion ||
      proof.attemptId !== source.apiParent.attemptId ||
      proof.operationKey !== source.execution.operationKey ||
      proof.fingerprint !== source.execution.fingerprint ||
      proof.terminalDigest !== source.canonicalDigest ||
      proof.checkpointOwnerVersion < proof.originalApiOwnerVersion
    )
      throw new ConfigurationMaintenanceControlUnauthorized(
        "Actual durable maintenance receipt copy required",
      );
    const copy = {
      terminalCopyId: proof.terminalCopyId,
      checkpointOwnerVersion: proof.checkpointOwnerVersion,
      proofDigest: controlDigest(proof),
    };
    if (source.receiptDelivery) {
      if (canonicalJson(source.receiptDelivery) !== canonicalJson(copy))
        throw new ConfigurationMaintenanceControlConflict(
          "Original maintenance receipt copy changed",
        );
    } else
      write(authority, {
        ...owner,
        apiControls: { ...owner.apiControls, [slot]: { ...source, receiptDelivery: copy } },
      });
    return { acknowledged: true as const };
  };
  let lease: ArtifactTargetLease | undefined;
  try {
    lease = restoreArtifactTargetLeaseForSettlement(authority);
    return withConfigurationMaintenanceOwnerObservation(lease, authority, publish);
  } catch {
    // Only the actual immutable released-root proof permits late delivery.
    // No physical handle or forward authority is recreated by this ACK.
    verifyRetainedArtifactTargetRootRelease(authority);
    return withPrivateEffectWriter(executionAuthorityState(authority), publish);
  } finally {
    if (lease) closeArtifactTargetLeaseHandle(lease);
  }
}
/** This is only a bounded synchronous observation of an authenticated original
 * owner. It produces no forward authority, grant, lease or retained execution;
 * the generic child/parent normalization and original root deadline stay exact. */
export function normalizeConfigurationMaintenanceInspection(
  value: ConfigurationMaintenanceControlOwner,
  operation: Extract<OpsOperation, { kind: "configurationMaintenance.inspect" }>,
  requestKey: string,
  admittedAt: number,
  deploymentBudgetMs: number,
) {
  const source = configurationMaintenanceControlOwnerState(value, operation, requestKey);
  if (
    !Number.isSafeInteger(admittedAt) ||
    admittedAt < 0 ||
    !Number.isSafeInteger(deploymentBudgetMs) ||
    deploymentBudgetMs <= 0
  )
    throw Error("Bounded original maintenance inspection required");
  const deadlineAt = Math.min(
    source.requestedDeadlineAt,
    admittedAt + Math.min(15000, deploymentBudgetMs),
  );
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= admittedAt)
    throw Error("Elapsed original maintenance inspection");
  return {
    admittedAt,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint: source.operationFingerprint,
      deadlineAt,
      parent: source.parent,
    }),
  };
}
/** Only this live original-owner source can select the finite cancellation /
 * expiry control clock. It grants no forward child, lease or renewed root. */
export function normalizeConfigurationMaintenanceRecoveryControl(
  value: ConfigurationMaintenanceControlOwner,
  operation: ConfigurationMaintenanceDecision | ConfigurationMaintenanceSettle,
  requestKey: string,
  admittedAt: number,
  deploymentBudgetMs: number,
) {
  const source = configurationMaintenanceControlOwnerState(value, operation, requestKey);
  verifyControlRecoveryAuthority(source.authority);
  if (
    (operation.kind === "configurationMaintenance.decide" && operation.decision !== "abandon") ||
    !Number.isSafeInteger(admittedAt) ||
    admittedAt < 0 ||
    !Number.isSafeInteger(deploymentBudgetMs) ||
    deploymentBudgetMs < 1 ||
    deploymentBudgetMs > 60000
  )
    throw Error("Original no-effect maintenance recovery control required");
  const deadlineAt = Math.min(source.requestedDeadlineAt, admittedAt + deploymentBudgetMs);
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= admittedAt)
    throw Error("Elapsed original maintenance control attempt");
  return {
    admittedAt,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint: source.operationFingerprint,
      deadlineAt,
      parent: source.parent,
    }),
  };
}
/** Records the data-manager's prepared receipt. The receipt is accepted only
 * when the data-manager's own signed settlement of the fence child in this
 * lease committed exactly that receipt. */
export function recordOwnedConfigurationMaintenancePrepared(
  authority: VerifiedExecutionAuthority,
  lease: ArtifactTargetLease,
  expectedSequence: number,
  child: ExecutionRef,
  receipt: DataConfigurationFenceReceipt,
): void {
  const settled = inspectArtifactTargetLeaseChildSettlement(lease, child);
  if (
    settled?.outcome !== "committed" ||
    settled.terminalReceiptDigest !== controlDigest({ kind: "data-configuration-fence", receipt })
  )
    throw Error("Data-manager fence preparation required");
  withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
    const owner = read(authority),
      plan = owner.plan;
    if (
      owner.sequence !== expectedSequence ||
      owner.receipt.state !== "preparing" ||
      owner.preparedFence ||
      receipt.state !== "prepared" ||
      receipt.fenceId !== child.executionId ||
      canonicalJson(receipt.ownerPrepare) !== canonicalJson(plan.prepare) ||
      receipt.maintenanceId !== plan.operation.maintenanceId ||
      receipt.candidateId !== plan.operation.candidateId ||
      receipt.planDigest !== plan.planDigest ||
      receipt.revisionId !== plan.operation.revisionId ||
      receipt.hardlinkPlanDigest !== plan.dmPrepare.hardlinkPlanDigest
    )
      throw Error("Original prepared maintenance guard conflict");
    const next = owner.sequence + 1;
    write(authority, {
      ...owner,
      sequence: next,
      preparedFence: receipt,
      receipt: { ...owner.receipt, sequence: next, state: "prepared", dmFence: receipt },
    });
  });
}

declare const maintenanceFinalBrand: unique symbol;
export type VerifiedMaintenanceFinal = Readonly<{ [maintenanceFinalBrand]: true }>;
const maintenanceFinals = new WeakMap<
  VerifiedMaintenanceFinal,
  {
    authority: VerifiedExecutionAuthority;
    record: NonNullable<ConfigurationMaintenanceOwnerRecord["final"]>;
  }
>();
export function ownedMaintenanceFinalState(
  value: VerifiedMaintenanceFinal,
  authority: VerifiedExecutionAuthority,
) {
  const source = maintenanceFinals.get(value);
  if (!source || source.authority !== authority)
    throw Error("Actual original maintenance final required");
  return source;
}
/** Dedicated original-owner final CAS. No parsed evidence, requested outcome
 * or signature from a caller creates inspection/final authority. */
export function finalizeOwnedMaintenanceState(
  authority: VerifiedExecutionAuthority,
  inspection: MaintenanceRuntimeInspection,
): VerifiedMaintenanceFinal {
  const actual = maintenanceRuntimeInspectionState(inspection, authority),
    applied =
      actual.signed.payload.runtime.mode !== "unused"
        ? readOriginalMaintenanceFinalChildren(
            authority,
            observeConfigurationMaintenanceRuntimeTree(authority),
          )
        : null,
    lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
      const owner = read(authority),
        payload = verifyControl(
          executionAuthorityState(authority).installation.installation.publicKey,
          domains.inspection,
          actual.signed,
          configurationMaintenanceRuntimeInspectionSchema,
        );
      if (owner.final) {
        if (canonicalJson(owner.inspection) !== canonicalJson(actual.signed))
          throw Error("Immutable original maintenance final changed");
        return;
      }
      if (
        owner.sequence !== payload.ownerSequence ||
        controlDigest(owner) !== payload.ownerSourceDigest ||
        owner.inspection ||
        !owner.preparedFence ||
        !owner.apiControls.decide?.receiptDelivery ||
        !(payload.runtime.mode === "unused"
          ? owner.receipt.decision?.decision === "abandon" &&
            owner.receipt.generation === "not_started" &&
            owner.receipt.followUp === "not_started" &&
            owner.apiControls.steps.length === 0
          : (payload.runtime.mode === "applied" &&
              applied?.complete &&
              applied.ownerDigest === controlDigest(owner) &&
              applied.generation &&
              owner.receipt.decision?.decision === "continue" &&
              owner.receipt.generation === "committed" &&
              owner.receipt.followUp === "complete") ||
            (payload.runtime.mode === "contained" &&
              applied?.generationResult?.outcome === "not_committed" &&
              !applied.generationResult.cleanupFailed &&
              applied.children.length === 1 &&
              owner.apiControls.steps.length === 1 &&
              applied.ownerDigest === controlDigest(owner) &&
              owner.receipt.decision?.decision === "continue" &&
              owner.receipt.generation === "not_committed" &&
              owner.receipt.appliedRevisionId === null &&
              owner.receipt.followUp === "contained"))
      )
        throw Error("Actual immutable final source raced");
      for (const step of payload.runtime.mode === "unused" ? owner.plan.steps : []) {
        const publication = inspectControlChildPublication(authority, step);
        if (publication.binding !== null || publication.publication.state !== "unissued")
          throw Error("Unused final has attempted frozen work");
      }
      const state = executionAuthorityState(authority),
        decision = owner.apiControls.decide,
        prepared = owner.preparedFence,
        evidence = configurationFinalEvidenceSchema.parse({
          identity: payload.identity,
          guard: { fenceId: prepared.fenceId, preparedReceipt: prepared },
          decision: {
            ...owner.receipt.decision,
            apiParentAttestationDigest: decision.apiParent.assertionDigest,
          },
          children: applied?.children ?? [],
          generation:
            applied && payload.runtime.mode === "applied"
              ? {
                  state: "committed",
                  revisionId: owner.plan.operation.revisionId,
                  commitReceiptDigest: applied.generation!.terminalDigest,
                }
              : { state: "not_committed", revisionId: null, commitReceiptDigest: null },
          followUp: applied
            ? {
                state: payload.runtime.mode === "contained" ? "contained" : "complete",
                receiptDigests: applied.followUpReceiptDigests,
              }
            : { state: "not_started", receiptDigests: [] },
          runtime: payload.runtime,
          outcome: payload.runtime.mode,
        }),
        evidenceProjection = configurationFinalEvidenceProjectionSchema.parse({
          ...evidence,
          children: evidence.children.map(({ execution, ...child }) => ({
            ...child,
            executionDigest: controlDigest(execution),
          })),
        }),
        evidenceDigest = finalRecordDigest(domains.finalEvidence, evidenceProjection),
        sequence = owner.sequence + 1,
        finalPayload = configurationOwnerFinalSchema.parse({
          version: 2,
          identity: payload.identity,
          ownerSequence: sequence,
          settlingAt: Date.now(),
          expectedDmSequence: prepared.sequence,
          evidenceDigest,
          outcome: payload.runtime.mode,
          privateInspectionId: payload.inspectionId,
        }),
        final = configurationMaintenanceFinalRecordSchema.parse({
          ownerFinal: signControl(state.installation.privateKey, domains.ownerFinal, finalPayload),
          evidence,
          evidenceProjection,
          evidenceDigest,
          ownerReceiptDigest: finalRecordDigest(domains.ownerFinal, finalPayload),
        });
      write(authority, {
        ...owner,
        sequence,
        final,
        inspection: actual.signed,
        receipt: { ...owner.receipt, sequence, state: "settling" },
      });
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
  return restoreOwnedMaintenanceFinal(authority);
}
/** Restore the original actual signed private inspection/final and all digest
 * preimages. This never samples current desired state or invents a new runtime
 * verification ID/time. Missing/torn/different originals stay fenced. */
export function restoreOwnedMaintenanceFinal(
  authority: VerifiedExecutionAuthority,
): VerifiedMaintenanceFinal {
  const owner = read(authority),
    final = owner.final,
    state = executionAuthorityState(authority);
  if (
    !final ||
    !owner.inspection ||
    !owner.preparedFence ||
    !owner.apiControls.decide?.receiptDelivery
  )
    throw Error("Actual immutable maintenance final required");
  if (
    final.ownerFinal.payload.outcome === "applied" ||
    final.ownerFinal.payload.outcome === "contained"
  ) {
    const contained = final.ownerFinal.payload.outcome === "contained";
    if (contained) assertContainedConfigurationMaintenanceFinalState(owner);
    else assertAppliedConfigurationMaintenanceFinalState(owner);
    const actual = readOriginalMaintenanceFinalChildren(
      authority,
      observeConfigurationMaintenanceRuntimeTree(authority),
    );
    if (
      (!contained && !actual.complete) ||
      (contained &&
        (actual.generationResult?.outcome !== "not_committed" ||
          actual.generationResult.cleanupFailed ||
          actual.children.length !== 1)) ||
      canonicalJson(actual.children) !== canonicalJson(final.evidence.children) ||
      final.evidence.generation.commitReceiptDigest !==
        (contained ? null : actual.generation?.terminalDigest) ||
      canonicalJson(final.evidence.followUp.receiptDigests) !==
        canonicalJson(actual.followUpReceiptDigests)
    )
      throw Error("Original applied final child sources changed");
  } else assertUnusedConfigurationMaintenanceFinalState(owner);
  const inspection = verifyControl(
      state.installation.installation.publicKey,
      domains.inspection,
      owner.inspection,
      configurationMaintenanceRuntimeInspectionSchema,
    ),
    actual = verifyControl(
      state.installation.installation.publicKey,
      domains.ownerFinal,
      final.ownerFinal,
      configurationOwnerFinalSchema,
    ),
    evidence = final.evidence,
    { children, ...base } = evidence,
    projection = configurationFinalEvidenceProjectionSchema.parse({
      ...base,
      children: children.map(({ execution, ...child }) => ({
        ...child,
        executionDigest: controlDigest(execution),
      })),
    });
  if (
    actual.outcome !== evidence.outcome ||
    inspection.runtime.mode !== actual.outcome ||
    actual.ownerSequence > owner.sequence ||
    actual.ownerSequence !== inspection.ownerSequence + 1 ||
    actual.privateInspectionId !== inspection.inspectionId ||
    canonicalJson(actual.identity) !== canonicalJson(inspection.identity) ||
    canonicalJson(actual.identity) !== canonicalJson(evidence.identity) ||
    actual.identity.admissionDigest !== state.receiptDigest ||
    canonicalJson(actual.identity.ownerPrepare) !== canonicalJson(state.execution) ||
    actual.identity.maintenanceId !== owner.plan.operation.maintenanceId ||
    actual.identity.candidateId !== owner.plan.operation.candidateId ||
    actual.identity.planDigest !== owner.plan.planDigest ||
    actual.identity.rootCertificateDigest !== owner.rootCertificateDigest ||
    canonicalJson(evidence.runtime) !== canonicalJson(inspection.runtime) ||
    inspection.runtime.requiredCheckSetDigest !==
      finalRecordDigest(domains.inspection, inspection.requiredChecks) ||
    inspection.observations.length !== inspection.requiredChecks.length ||
    !inspection.observations.every((value, index) => value.checkIndex === index && value.passed) ||
    canonicalJson(projection) !== canonicalJson(final.evidenceProjection) ||
    finalRecordDigest(domains.finalEvidence, projection) !== final.evidenceDigest ||
    final.evidenceDigest !== actual.evidenceDigest ||
    finalRecordDigest(domains.ownerFinal, actual) !== final.ownerReceiptDigest ||
    canonicalJson(evidence.guard.preparedReceipt) !== canonicalJson(owner.preparedFence) ||
    actual.expectedDmSequence !== owner.preparedFence.sequence ||
    evidence.decision.decisionId !== owner.receipt.decision?.decisionId ||
    evidence.decision.decision !== owner.receipt.decision?.decision ||
    evidence.decision.checkpointVersion !== owner.receipt.decision.checkpointVersion ||
    evidence.decision.checkpointDigest !== owner.receipt.decision.checkpointDigest ||
    evidence.decision.apiParentAttestationDigest !==
      owner.apiControls.decide.apiParent.assertionDigest ||
    (actual.outcome === "unused" && (children.length > 0 || owner.apiControls.steps.length > 0))
  )
    throw Error("Original maintenance final proof changed");
  for (const step of actual.outcome === "unused" ? owner.plan.steps : []) {
    const publication = inspectControlChildPublication(authority, step);
    if (publication.binding !== null || publication.publication.state !== "unissued")
      throw Error("Final unused source has attempted frozen work");
  }
  const value = Object.freeze({}) as VerifiedMaintenanceFinal;
  const freezeProof = <T>(input: T): T => {
    if (input && typeof input === "object") {
      for (const child of Object.values(input)) freezeProof(child);
      Object.freeze(input);
    }
    return input;
  };
  maintenanceFinals.set(value, Object.freeze({ authority, record: freezeProof(final) }));
  return value;
}

/** Uses the existing original-root recovery sequence, never a new owner or a
 * caller-selected settlement. Every physical settle/release path rechecks the
 * same full disjoint closure predicate. Completion metadata follows the actual
 * retained release proof; a lost metadata write can only finish that proof. */
export async function releaseOwnedConfigurationMaintenanceRoot(
  authority: VerifiedExecutionAuthority,
): Promise<ConfigurationMaintenanceReceipt> {
  const state = executionAuthorityState(authority),
    original = read(authority);
  restoreOwnedMaintenanceFinal(authority);
  assertConfigurationMaintenanceRootClosure(authority);
  if (original.receipt.state === "settled") {
    verifyRetainedArtifactTargetRootRelease(authority);
    return original.receipt;
  }
  // Physical release precedes this owner's metadata publication. A lost owner
  // write must observe that retained release, rather than reopen a lease whose
  // active target entry was already removed. Failure still takes only the
  // original settlement-only reconciliation path, which verifies its sources.
  let physicallyReleased = false;
  try {
    verifyRetainedArtifactTargetRootRelease(authority);
    physicallyReleased = true;
  } catch {
    /* A held/partial original release is reconciled below. */
  }
  if (!physicallyReleased) {
    const lease = restoreArtifactTargetLeaseForSettlement(authority),
      leaseId = lease.leaseId;
    closeArtifactTargetLeaseHandle(lease);
    const released = await reconcileArtifactTargetLease({
      dataRoot: state.installation.dataRoot,
      leaseId,
      authority: verifyControlRecoveryAuthority(authority),
    });
    if (released !== "released") throw Error("Original prepared maintenance root remains fenced");
  }
  verifyRetainedArtifactTargetRootRelease(authority);
  assertConfigurationMaintenanceRootClosure(authority);
  return withPrivateEffectWriter(state, () => {
    const current = read(authority);
    if (
      canonicalJson(current.final) !== canonicalJson(original.final) ||
      !current.preparedFence ||
      current.receipt.dmFence?.state !== "settled" ||
      !["settling", "settled"].includes(current.receipt.state)
    )
      throw Error("Original released maintenance completion source changed");
    if (current.receipt.state === "settled") return current.receipt;
    const completed = configurationMaintenanceReleasedOwner(current);
    write(authority, completed);
    return completed.receipt;
  });
}

/** Recovers an expired preparation the data-manager never admitted: the
 * data-manager signs that observation, then the never-prepared root releases. */
export async function recoverUnadmittedConfigurationMaintenance(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
) {
  const state = executionAuthorityState(authority),
    owner = read(authority);
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    Date.now() <= state.execution.deadlineAt ||
    owner.preparedFence ||
    owner.receipt.dmFence ||
    owner.receipt.generation !== "not_started" ||
    owner.receipt.followUp !== "not_started" ||
    owner.receipt.decision?.decision === "continue"
  )
    throw Error("Original expired never-applied preparation required");
  try {
    verifyRetainedArtifactTargetRootRelease(authority);
    assertConfigurationMaintenanceRootClosure(authority);
    return configurationMaintenanceRecoverySource(authority);
  } catch {
    /* Only original held/partially released recovery follows. */
  }
  await withUnconsumedMaintenanceCandidate(runtime, authority, () => {
    for (const reservation of owner.plan.reservations.filter(
      (value) => value.phase !== "configuration-fence",
    ))
      if (
        inspectControlChildPublication(authority, reservation).publication.state !== "unissued" ||
        lookupControlChildPhaseAttempt(authority, reservation)
      )
        throw Error("Another original maintenance phase was issued");
  });
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    const reservation = owner.plan.reservations.find(
      (value) => value.phase === "configuration-fence",
    );
    if (!reservation) throw Error("Original preparation reservation required");
    const attempt = lookupControlChildPhaseAttempt(authority, reservation);
    if (!attempt || attempt.channel !== "delegation")
      throw Error("Original preparation outbox required");
    // Cancellation closes forward issuance first. A lost response can only
    // repeat this same negative receiver observation, never PREPARE.
    cancelControlExecution(authority);
    let negative: ReturnType<typeof readConfigurationPrepareNonAdmission> | undefined;
    try {
      negative = readConfigurationPrepareNonAdmission(authority);
    } catch {
      /* First recovery. */
    }
    if (!negative) {
      await cancelArtifactTargetLease(lease);
      await recoverUnadmittedConfigurationPreparation(owner.plan.dmPrepare, {
        transport: configurationDataManagerTransport(),
        headers: { "x-openmapx-control-delegation": attempt.assertion },
      });
      negative = readConfigurationPrepareNonAdmission(authority);
    }
    if (canonicalJson(negative.payload.input) !== canonicalJson(owner.plan.dmPrepare))
      throw Error("Original preparation recovery body changed");
    retainConfigurationFenceNotPrepared(authority);
    if (
      (await reconcileArtifactTargetLease({
        dataRoot: state.installation.dataRoot,
        leaseId: lease.leaseId,
        authority: verifyControlRecoveryAuthority(authority),
      })) !== "released"
    )
      throw Error("Original unadmitted maintenance remains fenced");
    assertConfigurationMaintenanceRootClosure(authority);
    verifyRetainedArtifactTargetRootRelease(authority);
    return configurationMaintenanceRecoverySource(authority);
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}

/** The recovery result after the never-prepared root released: the
 * data-manager's signed observation that the prepare was never admitted. */
function configurationMaintenanceRecoverySource(authority: VerifiedExecutionAuthority) {
  assertConfigurationMaintenanceRootClosure(authority);
  const released = verifyRetainedArtifactTargetRootRelease(authority),
    owner = read(authority);
  return {
    maintenanceId: owner.plan.operation.maintenanceId,
    candidateId: owner.plan.operation.candidateId,
    receiverEvidenceDigest: controlDigest(readConfigurationPrepareNonAdmission(authority)),
    releasedAt: released.releasedAt,
  };
}
/** Records that this maintenance never prepared a fence, so its root can
 * release: the fence child was never issued, or the data-manager settled it
 * without effect. Anything else stays unknown and keeps the root held. */
function retainConfigurationFenceNotPrepared(authority: VerifiedExecutionAuthority): void {
  const owner = read(authority);
  if (owner.preparedFence || owner.receipt.dmFence) throw Error("A prepared fence is held");
  retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: {
      kind: "configuration-fence-not-prepared",
      maintenanceId: owner.plan.operation.maintenanceId,
    },
  });
  if (
    childSettlementState(
      verifyControlEffectSettlement(
        executionAuthorityState(authority).installation.installation,
        executionAuthorityState(authority).execution,
      ),
    ).evidence.outcome !== "failed_without_effect"
  )
    throw Error("Never-prepared maintenance remains unknown");
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
      const current = read(authority);
      if (current.receipt.state === "settled") return;
      const sequence = current.sequence + 1;
      write(authority, {
        ...current,
        sequence,
        receipt: { ...current.receipt, sequence, state: "settled" },
      });
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
/** Repeats one idempotent data-manager call until it answers. Transport
 * failures and server errors repeat; any other answer is final. */
async function retryDataManager<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DataManagerHttpError && error.status < 500 && error.status !== 429)
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 250 * 2 ** attempt)));
  }
}
/** Settles the data-manager's fence with this owner's final outcome, using
 * the original prepare delegation, and records the settled receipt. */
async function settleOwnedConfigurationFence(
  authority: VerifiedExecutionAuthority,
  signal: AbortSignal,
): Promise<void> {
  const owner = read(authority);
  if (owner.receipt.dmFence?.state === "settled") return;
  const final = ownedMaintenanceFinalState(restoreOwnedMaintenanceFinal(authority), authority),
    reservation = owner.plan.reservations.find((value) => value.phase === "configuration-fence"),
    attempt = reservation && lookupControlChildPhaseAttempt(authority, reservation),
    prepared = owner.preparedFence;
  if (!attempt || attempt.channel !== "delegation" || !prepared)
    throw Error("Original fence preparation required");
  const receipt = await retryDataManager(signal, () =>
    settleDataConfigurationFence(
      {
        maintenanceId: owner.plan.operation.maintenanceId,
        candidateId: owner.plan.operation.candidateId,
        planDigest: owner.plan.planDigest,
        outcome: final.record.ownerFinal.payload.outcome,
      },
      {
        transport: configurationDataManagerTransport(),
        controlAssertion: attempt.assertion,
        signal,
      },
    ),
  );
  if (
    canonicalJson({ ...receipt, sequence: prepared.sequence, state: prepared.state }) !==
      canonicalJson(prepared) ||
    receipt.state !== "settled"
  )
    throw Error("Original fence settlement changed");
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    withConfigurationMaintenanceOwnerObservation(lease, authority, () => {
      const current = read(authority);
      if (current.receipt.dmFence?.state === "settled") return;
      const sequence = current.sequence + 1;
      write(authority, {
        ...current,
        sequence,
        receipt: { ...current.receipt, sequence, dmFence: receipt },
      });
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}

// The actual admission/inspection producer and its private consumer share ONE nominal owner.
interface Source {
  rootDir?: string;
  infraDir: string;
  candidateSource?: ConfigurationCandidateSource;
  stack: services.StackPaths;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
  ownedServices: OwnedServiceResolver;
}
const sources = new WeakMap<OpsRuntime, Source>();
/** The normal root remains held while this writer-side preflight runs. Release
 * the writer before invoking the fixed CLI, which acquires its own writer. */
export async function assertManagedCliConfigurationPreflight(
  runtime: OpsRuntime,
  operation: OpsOperation,
  context: import("./runtime").OpsExecutionContext,
): Promise<void> {
  if (
    !(
      operation.kind === "service.update" ||
      operation.kind === "stack.start" ||
      (operation.kind === "service.start" && operation.serviceId !== "data-manager")
    )
  )
    return;
  const source = sources.get(runtime),
    lease = context.ownedTargetLease;
  if (!source || !context.controlAuthority || !lease || context.artifactLease)
    throw Error("Original full managed configuration target owner required");
  const targets = (await source.loadAuthority()).services
    .map((service) => service.manifest.id)
    .sort();
  if (canonicalJson(targets) !== canonicalJson(lease.serviceIds))
    throw Error("Managed configuration target closure changed");
  try {
    await services.withConfigurationGenerationWriter(
      source.infraDir,
      () => assertStagedCoordinatorConfigurationWrite(runtime, operation, context, context.signal),
      context.signal,
    );
  } catch (error) {
    if (
      error instanceof services.ConfigurationGenerationError &&
      error.result.outcome === "not_committed" &&
      !error.result.cleanupFailed &&
      error.cause instanceof OpsExecutionFailure &&
      error.cause.errorClass === "configuration_prerequisite"
    )
      throw error.cause;
    throw error;
  }
}
/** Read only from this runtime's existing fixed source and literal resolver.
 * Planned eligibility never substitutes for actual nominal publication. */
export async function assertStagedCoordinatorReleaseWrite(
  runtime: OpsRuntime,
  signal: AbortSignal,
): Promise<void> {
  const source = sources.get(runtime);
  if (
    !source ||
    (await inspectLiteralStagedConfigurationDependency(source.ownedServices, signal)) !== "none"
  )
    throw new OpsExecutionFailure("configuration_prerequisite", {});
}

export async function assertStagedCoordinatorConfigurationWrite(
  runtime: OpsRuntime,
  operation: OpsOperation,
  context: import("./runtime").OpsExecutionContext,
  signal: AbortSignal,
): Promise<void> {
  const source = sources.get(runtime);
  if (!source) throw new OpsExecutionFailure("configuration_prerequisite", {});
  const dependency = await inspectLiteralStagedConfigurationDependency(
    source.ownedServices,
    signal,
  );
  if (dependency === "none") return;
  if (dependency === "required") {
    try {
      if (operation.kind === "configuration.hardlinks.preview") {
        await assertPlannedCoordinatorConfigurationWrite(runtime, operation);
        return;
      }
      if (
        (operation.kind === "stack.render" || operation.kind === "vault.apply") &&
        operation.maintenanceId
      ) {
        await assertOwnedCoordinatorConfigurationWrite(runtime, context, operation, signal);
        return;
      }
    } catch {
      /* Changed or foreign producer keeps the prerequisite closed. */
    }
  }
  throw new OpsExecutionFailure("configuration_prerequisite", {});
}
const journals = new WeakMap<OpsRuntime, OpsJobJournal>();
const journalInstallations = new WeakMap<OpsRuntime, ControlInstallation>();
/** Conservative drain gate from the actual durable journal. This closes new
 * work only; a matching ID never supplies continuation or release authority. */
export function configurationHandoffPendingMaintenanceIds(
  runtime: OpsRuntime,
): ReadonlySet<string> {
  return new Set(
    (journals.get(runtime)?.records() ?? [])
      .filter((job) => {
        if (job.operation.kind !== "configurationHandoff.prepare") return false;
        const installation = journalInstallations.get(runtime);
        if (!installation) return true;
        try {
          const local = installationState(installation),
            file = `${job.operation.maintenanceId}.json`,
            raw = readPrivateRecord(local, "configuration-maintenance", file),
            owner = verifyControl(installation.publicKey, domain, raw, ownerSchema);
          verifyFamilyOwnedRecord(
            local,
            owner.origin,
            { scope: "private", namespace: "configuration-maintenance", container: "", name: file },
            canonicalJson(raw),
          );
          if (
            owner.receipt.state !== "settled" ||
            !owner.plan.handoff ||
            owner.plan.handoff.handoffId !== job.operation.handoffId
          )
            return true;
          const authority = restoreAdmittedControlExecution(installation, owner.plan.prepare);
          restoreOwnedMaintenanceFinal(authority);
          assertConfigurationMaintenanceRootClosure(authority);
          verifyRetainedArtifactTargetRootRelease(authority);
          return false;
        } catch {
          return true;
        }
      })
      .map(
        (job) =>
          (job.operation as Extract<OpsOperation, { kind: "configurationHandoff.prepare" }>)
            .maintenanceId,
      ),
  );
}
/** Bound to the server's actual durable journal. Records alone cannot qualify
 * a pull: the fixed reader authenticates canonical/effect/private admissions. */
export function registerConfigurationMaintenanceJournal(
  runtime: OpsRuntime,
  journal: OpsJobJournal,
  installation?: ControlInstallation,
) {
  if (journals.has(runtime)) throw Error("Maintenance journal source already bound");
  journals.set(runtime, journal);
  if (installation) journalInstallations.set(runtime, installation);
  return () => {
    if (journals.get(runtime) === journal) {
      journals.delete(runtime);
      journalInstallations.delete(runtime);
    }
  };
}
declare const admissionBrand: unique symbol;
export type ConfigurationMaintenanceAdmission = Readonly<{ [admissionBrand]: true }>;
interface AdmissionState {
  plan: FixedConfigurationMaintenancePlan;
  originalContainers: readonly OwnedServiceSnapshot[];
  coordinatorPull?: CoordinatorPullWitness;
  stagedCoordinatorProvenance?: StagedCoordinatorObservation;
}
const admissions = new WeakMap<ConfigurationMaintenanceAdmission, AdmissionState>();
declare const continueObservationBrand: unique symbol;
export type MaintenanceContinueObservation = Readonly<{ [continueObservationBrand]: true }>;
const continueObservations = new WeakMap<
  MaintenanceContinueObservation,
  {
    authority: VerifiedExecutionAuthority;
    ownerDigest: string;
    observedAt: number;
    sealExpiresAt: number;
  }
>();
/** Only the fixed production sources create this short-lived observation.
 * It never authorizes an effect or survives as a parsed summary. */
export async function prepareMaintenanceContinueObservation(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
  signal: AbortSignal,
): Promise<MaintenanceContinueObservation> {
  const source = sources.get(runtime),
    owner = readOwnedConfigurationMaintenance(authority),
    state = executionAuthorityState(authority);
  if (
    !source?.candidateSource ||
    owner.receipt.state !== "prepared" ||
    owner.receipt.decision ||
    !owner.preparedFence
  )
    throw Error("Original prepared maintenance continue source required");
  const fresh = configurationMaintenanceAdmissionState(
    await prepareConfigurationMaintenanceAdmission(runtime, {
      installation: state.installation.installation,
      execution: owner.plan.prepare,
      operation: owner.plan.operation,
      apiParent: owner.plan.apiParent,
      signal,
      ...(owner.plan.release ? { frozenRelease: owner.plan.release } : {}),
    }),
  );
  if (
    canonicalJson(fresh.plan) !== canonicalJson(owner.plan) ||
    canonicalJson(fresh.originalContainers) !== canonicalJson(owner.originalContainers)
  )
    throw Error("Original maintenance source drifted before decision");
  const candidate = await readConfigurationCandidate(
      source.candidateSource,
      owner.plan.operation.candidateId,
    ),
    issuedAt = Date.now(),
    witness = signControl(
      state.installation.privateKey,
      "openmapx-configuration-fence-inspect-v1",
      {
        installationId: owner.installationId,
        maintenanceId: owner.plan.operation.maintenanceId,
        candidateId: owner.plan.operation.candidateId,
        ownerCertificateDigest: owner.rootCertificateDigest,
        issuedAt,
        expiresAt: Math.min(state.execution.deadlineAt, issuedAt + 15000),
      },
    ),
    actual = await inspectDataConfigurationFence(owner.plan.operation.maintenanceId, {
      transport: configurationDataManagerTransport(),
      witness: Buffer.from(canonicalJson(witness)).toString("base64url"),
      signal,
    });
  if (
    canonicalJson(actual) !== canonicalJson(owner.preparedFence) ||
    controlDigest(candidate.record) !== owner.plan.candidateRecordDigest ||
    canonicalJson(readOwnedConfigurationMaintenance(authority)) !== canonicalJson(owner)
  )
    throw Error("Original prepared maintenance guard/candidate changed");
  signal.throwIfAborted();
  const value = Object.freeze({}) as MaintenanceContinueObservation;
  continueObservations.set(value, {
    authority,
    ownerDigest: controlDigest(owner),
    observedAt: Date.now(),
    sealExpiresAt: candidate.snapshot.expiresAtMs,
  });
  return value;
}
export function consumeMaintenanceContinueObservation(
  value: MaintenanceContinueObservation | undefined,
  authority: VerifiedExecutionAuthority,
): void {
  const observed = value && continueObservations.get(value),
    now = Date.now();
  if (
    !observed ||
    observed.authority !== authority ||
    !Number.isSafeInteger(observed.sealExpiresAt) ||
    now < observed.observedAt ||
    now - observed.observedAt > 15000 ||
    now >= observed.sealExpiresAt ||
    observed.ownerDigest !== controlDigest(readOwnedConfigurationMaintenance(authority))
  )
    throw Error("Actual current maintenance continue observation required");
  continueObservations.delete(value!);
}
/** Fixed first-generation source check; no callback or caller receipt can
 * replace the actual candidate/current/host/container/ready/DM observations. */
export async function verifyFrozenMaintenanceGenerationSource(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
  signal: AbortSignal,
): Promise<void> {
  const source = sources.get(runtime),
    owner = readOwnedConfigurationMaintenance(authority),
    state = executionAuthorityState(authority);
  if (
    !source?.candidateSource ||
    owner.receipt.state !== "authorized" ||
    owner.receipt.decision?.decision !== "continue" ||
    !owner.apiControls.decide?.receiptDelivery ||
    !owner.preparedFence ||
    owner.receipt.generation !== "not_started"
  )
    throw Error("Original frozen maintenance generation source required");
  const fresh = configurationMaintenanceAdmissionState(
    await prepareConfigurationMaintenanceAdmission(runtime, {
      installation: state.installation.installation,
      execution: owner.plan.prepare,
      operation: owner.plan.operation,
      apiParent: owner.plan.apiParent,
      signal,
      ...(owner.plan.release ? { frozenRelease: owner.plan.release } : {}),
    }),
  );
  if (
    canonicalJson(fresh.plan) !== canonicalJson(owner.plan) ||
    canonicalJson(fresh.originalContainers) !== canonicalJson(owner.originalContainers)
  )
    throw Error("Frozen maintenance generation source drifted");
  const issuedAt = Date.now(),
    witness = signControl(
      state.installation.privateKey,
      "openmapx-configuration-fence-inspect-v1",
      {
        installationId: owner.installationId,
        maintenanceId: owner.plan.operation.maintenanceId,
        candidateId: owner.plan.operation.candidateId,
        ownerCertificateDigest: owner.rootCertificateDigest,
        issuedAt,
        expiresAt: Math.min(state.execution.deadlineAt, issuedAt + 15000),
      },
    ),
    actual = await inspectDataConfigurationFence(owner.plan.operation.maintenanceId, {
      transport: configurationDataManagerTransport(),
      witness: Buffer.from(canonicalJson(witness)).toString("base64url"),
      signal,
    });
  if (
    canonicalJson(actual) !== canonicalJson(owner.preparedFence) ||
    canonicalJson(readOwnedConfigurationMaintenance(authority)) !== canonicalJson(owner)
  )
    throw Error("Frozen maintenance generation guard/source changed");
  signal.throwIfAborted();
}
/** Follow-up consumes only this owner's actual committed generation and
 * terminal first child. It never rereads desired rows, renders or starts DM. */
export async function verifyFrozenMaintenanceHardlinksSource(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
  signal: AbortSignal,
): Promise<void> {
  const source = sources.get(runtime),
    owner = readOwnedConfigurationMaintenance(authority),
    state = executionAuthorityState(authority),
    generation = owner.apiControls.steps.find((value) => value.ordinal === 0);
  if (
    !source ||
    owner.receipt.state !== "applying" ||
    owner.receipt.decision?.decision !== "continue" ||
    owner.receipt.generation !== "committed" ||
    owner.receipt.appliedRevisionId !== owner.plan.operation.revisionId ||
    !generation?.canonical ||
    !generation.receiptDelivery ||
    !owner.preparedFence ||
    !owner.plan.nestedHardlinks
  )
    throw Error("Original committed maintenance generation prerequisite required");
  const verified = verifyConfigurationMaintenanceChildTerminal(
      authority,
      0,
      generation.canonical.status,
      generation.canonical.terminalAt,
    ),
    proof = configurationMaintenanceChildState(verified, authority),
    lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    const physical = inspectArtifactTargetLeaseChildSettlement(lease, generation.execution);
    if (!physical || canonicalJson(physical) !== canonicalJson(proof.settlement))
      throw Error("Original generation child settlement required");
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
  if (
    services.currentConfigurationGeneration(source.infraDir) !== owner.plan.operation.revisionId ||
    canonicalJson(
      readOwnedGenerationHardlinkPlan(source.infraDir, owner.plan.operation.revisionId),
    ) !== canonicalJson(owner.plan.hardlinkPlan)
  )
    throw Error("Original committed hardlink generation changed");
  const containers = await inspectOriginalOwnerServices(source, authority, signal);
  if (containers.find((value) => value.serviceId === "data-manager")?.state !== "running")
    throw Error("Original maintenance coordinator stopped");
  await assertConfigurationCoordinatorReady(signal);
  const issuedAt = Date.now(),
    witness = signControl(
      state.installation.privateKey,
      "openmapx-configuration-fence-inspect-v1",
      {
        installationId: owner.installationId,
        maintenanceId: owner.plan.operation.maintenanceId,
        candidateId: owner.plan.operation.candidateId,
        ownerCertificateDigest: owner.rootCertificateDigest,
        issuedAt,
        expiresAt: Math.min(state.execution.deadlineAt, issuedAt + 15000),
      },
    ),
    actual = await inspectDataConfigurationFence(owner.plan.operation.maintenanceId, {
      transport: configurationDataManagerTransport(),
      witness: Buffer.from(canonicalJson(witness)).toString("base64url"),
      signal,
    });
  if (
    canonicalJson(actual) !== canonicalJson(owner.preparedFence) ||
    canonicalJson(readOwnedConfigurationMaintenance(authority)) !== canonicalJson(owner) ||
    services.currentConfigurationGeneration(source.infraDir) !== owner.plan.operation.revisionId
  )
    throw Error("Original maintenance follow-up source changed");
  signal.throwIfAborted();
}
/** Ordinary frozen recreation only. Every earlier required child has its
 * original private canonical/effect, physical settlement and API copy ACK;
 * the committed generation and existing DM guard remain exact. */
export async function verifyFrozenMaintenanceRecreateSource(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
  ordinal: number,
  signal: AbortSignal,
): Promise<void> {
  return verifyFrozenMaintenanceFollowUpSource(
    runtime,
    authority,
    ordinal,
    signal,
    "maintenance-recreate",
  );
}
async function verifyFrozenMaintenanceFollowUpSource(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
  ordinal: number,
  signal: AbortSignal,
  expectedPhase: "maintenance-recreate" | "maintenance-handoff",
): Promise<void> {
  const source = sources.get(runtime),
    owner = readOwnedConfigurationMaintenance(authority),
    state = executionAuthorityState(authority),
    step = owner.plan.steps[ordinal];
  if (
    !source ||
    !step ||
    step.phase !== expectedPhase ||
    (expectedPhase === "maintenance-recreate" &&
      step.operation.kind !== "service.recreate" &&
      step.operation.kind !== "service.recreateIsolated") ||
    (expectedPhase === "maintenance-handoff" &&
      step.operation.kind !== "configurationHandoff.prepare") ||
    owner.receipt.state !== "applying" ||
    owner.receipt.decision?.decision !== "continue" ||
    !owner.apiControls.decide?.receiptDelivery ||
    !owner.preparedFence ||
    owner.receipt.generation !== "committed" ||
    owner.receipt.appliedRevisionId !== owner.plan.operation.revisionId ||
    services.currentConfigurationGeneration(source.infraDir) !== owner.plan.operation.revisionId
  )
    throw Error("Original frozen recreation generation required");
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    for (const index of step.prerequisites) {
      const child = owner.apiControls.steps.find((value) => value.ordinal === index);
      if (!child?.canonical || !child.receiptDelivery)
        throw Error("Original recreation prerequisite copy required");
      const proof = configurationMaintenanceChildState(
          verifyConfigurationMaintenanceChildTerminal(
            authority,
            index,
            child.canonical.status,
            child.canonical.terminalAt,
          ),
          authority,
        ),
        physical = inspectArtifactTargetLeaseChildSettlement(lease, child.execution);
      if (!physical || canonicalJson(physical) !== canonicalJson(proof.settlement))
        throw Error("Original recreation prerequisite settlement required");
    }
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
  const currentAuthority = await source.loadAuthority();
  if (currentAuthority.revisionId !== owner.plan.sourceAuthorityRevision)
    throw Error("Frozen recreation authority changed");
  if (owner.plan.hardlinkPlan.plan.length || owner.plan.coordinatorImage) {
    const containers = await inspectOriginalOwnerServices(source, authority, signal);
    if (containers.find((value) => value.serviceId === "data-manager")?.state !== "running")
      throw Error("Original recreation coordinator stopped");
    await assertConfigurationCoordinatorReady(signal);
  }
  const issuedAt = Date.now(),
    witness = signControl(
      state.installation.privateKey,
      "openmapx-configuration-fence-inspect-v1",
      {
        installationId: owner.installationId,
        maintenanceId: owner.plan.operation.maintenanceId,
        candidateId: owner.plan.operation.candidateId,
        ownerCertificateDigest: owner.rootCertificateDigest,
        issuedAt,
        expiresAt: Math.min(state.execution.deadlineAt, issuedAt + 15000),
      },
    ),
    actual = await inspectDataConfigurationFence(owner.plan.operation.maintenanceId, {
      transport: configurationDataManagerTransport(),
      witness: Buffer.from(canonicalJson(witness)).toString("base64url"),
      signal,
    });
  if (
    canonicalJson(actual) !== canonicalJson(owner.preparedFence) ||
    canonicalJson(readOwnedConfigurationMaintenance(authority)) !== canonicalJson(owner) ||
    services.currentConfigurationGeneration(source.infraDir) !== owner.plan.operation.revisionId
  )
    throw Error("Original recreation guard/generation changed");
  signal.throwIfAborted();
}
declare const runtimeInspectionBrand: unique symbol;
export type MaintenanceRuntimeInspection = Readonly<{ [runtimeInspectionBrand]: true }>;
const runtimeInspections = new WeakMap<
  MaintenanceRuntimeInspection,
  {
    authority: VerifiedExecutionAuthority;
    signed: ReturnType<
      typeof signControl<ReturnType<typeof configurationMaintenanceRuntimeInspectionSchema.parse>>
    >;
  }
>();
export function maintenanceRuntimeInspectionState(
  value: MaintenanceRuntimeInspection,
  authority: VerifiedExecutionAuthority,
) {
  const source = runtimeInspections.get(value);
  if (!source || source.authority !== authority)
    throw Error("Actual maintenance runtime inspection required");
  return source;
}
/** Fixed actual unused inspector. A decision/receipt alone proves nothing:
 * observe the real held tree, all original phase publications, retained
 * authenticated unconsumed candidate/queue, Docker inventory and DM SQL/mirror.
 * Applied/contained modes remain closed until their complete check matrix is
 * installed; they cannot borrow this no-effect producer. */
export async function inspectFrozenMaintenanceRuntime(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
  signal: AbortSignal,
): Promise<MaintenanceRuntimeInspection> {
  const source = sources.get(runtime),
    owner = readOwnedConfigurationMaintenance(authority),
    state = executionAuthorityState(authority);
  if (owner.receipt.decision?.decision === "continue") {
    const contained =
      owner.receipt.generation === "not_committed" &&
      owner.receipt.followUp === "contained" &&
      owner.receipt.appliedRevisionId === null;
    if (
      !source?.candidateSource ||
      owner.final ||
      owner.inspection ||
      !owner.preparedFence ||
      owner.receipt.state !== "applying" ||
      !owner.apiControls.decide?.receiptDelivery ||
      (!contained &&
        (owner.receipt.generation !== "committed" ||
          owner.receipt.appliedRevisionId !== owner.plan.operation.revisionId ||
          owner.receipt.followUp !== "complete"))
    )
      throw Error("Conclusive applied maintenance runtime source required");
    const children = readOriginalMaintenanceFinalChildren(
      authority,
      observeConfigurationMaintenanceRuntimeTree(authority),
    );
    if (
      (!contained && !children.complete) ||
      children.ownerDigest !== controlDigest(owner) ||
      !children.generation ||
      (contained &&
        (children.generationResult?.outcome !== "not_committed" ||
          children.generationResult.cleanupFailed ||
          children.children.length !== 1 ||
          owner.apiControls.steps.length !== 1))
    )
      throw Error("Complete original runtime child sources required");
    const candidate = await readRetainedConfigurationCandidate(
      source.candidateSource,
      owner.plan.operation.candidateId,
    );
    if (
      controlDigest(candidate.record) !== owner.plan.candidateRecordDigest ||
      candidate.snapshot.revisionId !== owner.plan.operation.revisionId
    )
      throw Error("Original committed candidate changed");
    const inspectContainers = () =>
      contained
        ? inspectOriginalOwnerServices(source, authority, signal)
        : source.ownedServices.inspectOwnedServices(signal);
    const containers = await inspectContainers(),
      recreateIds = [
        ...owner.plan.steps
          .filter((step) => step.phase === "maintenance-recreate")
          .map((step) => ("serviceId" in step.operation ? step.operation.serviceId : "")),
        ...(owner.plan.handoff?.serviceIds ?? []),
      ],
      unchanged = containers.filter((value) => !recreateIds.includes(value.serviceId));
    if (
      canonicalJson(unchanged) !==
      canonicalJson(
        owner.originalContainers.filter((value) => !recreateIds.includes(value.serviceId)),
      )
    )
      throw Error("Unchanged original owned runtime differs");
    if (contained && canonicalJson(containers) !== canonicalJson(owner.originalContainers))
      throw Error("Original noncommitted runtime changed");
    let currentRelease: { releaseId: string; digest: string; updateJobId: string } | undefined;
    if (!contained && owner.plan.release) {
      if (!owner.plan.handoff || owner.plan.apiParent.issuer !== "api")
        throw Error("Original release helper/current-state owner required");
      const original = readCompletedConfigurationHandoff(
          state.installation.installation,
          owner.plan.handoff.handoffId,
        ),
        published = original.completion.release,
        overlay = readConfigurationHandoffReleaseOverlay(source.infraDir),
        pointer = readConfigurationHandoffReleaseState(source.infraDir);
      currentRelease = {
        releaseId: owner.plan.release.releaseId,
        digest: owner.plan.release.manifestDigest,
        updateJobId: owner.plan.apiParent.apiJobId,
      };
      if (
        canonicalJson(original.intent.ownerPrepare) !== canonicalJson(owner.plan.prepare) ||
        original.intent.ownerCertificateDigest !== owner.rootCertificateDigest ||
        original.intent.operation.planDigest !== owner.plan.planDigest ||
        canonicalJson(original.intent.release) !== canonicalJson(owner.plan.release) ||
        published?.publication !== "published" ||
        published.statePublication !== "published" ||
        canonicalJson(overlay) !== canonicalJson(published.overlay) ||
        canonicalJson(pointer) !== canonicalJson(published.state) ||
        !overlay ||
        !pointer ||
        Buffer.from(pointer.bytes, "base64").toString("utf8") !== JSON.stringify(currentRelease) ||
        Buffer.from(overlay.bytes, "base64").toString("utf8") !==
          services.renderReleaseCompose(
            services.parseReleaseManifest(
              owner.plan.release.canonicalManifest,
              owner.plan.release.imagePrefix,
            ),
          )
      )
        throw Error("Original helper release publication changed before final inspection");
    }
    const docker = await inspectMaintenanceDockerRuntime({
      stack: source.stack,
      execFile: source.execFile,
      owner,
      containers,
      privateKey: state.installation.privateKey,
      signal,
    });
    if (owner.plan.hardlinkPlan.plan.length) await assertConfigurationCoordinatorReady(signal);
    const issuedAt = Date.now(),
      witness = signControl(
        state.installation.privateKey,
        "openmapx-configuration-fence-inspect-v1",
        {
          installationId: owner.installationId,
          maintenanceId: owner.plan.operation.maintenanceId,
          candidateId: owner.plan.operation.candidateId,
          ownerCertificateDigest: owner.rootCertificateDigest,
          issuedAt,
          expiresAt: issuedAt + 15000,
        },
      ),
      guard = await inspectDataConfigurationFence(owner.plan.operation.maintenanceId, {
        transport: configurationDataManagerTransport(),
        witness: Buffer.from(canonicalJson(witness)).toString("base64url"),
        signal,
      });
    if (
      canonicalJson(guard) !== canonicalJson(owner.preparedFence) ||
      canonicalJson(containers) !== canonicalJson(await inspectContainers()) ||
      canonicalJson(children) !==
        canonicalJson(
          readOriginalMaintenanceFinalChildren(
            authority,
            observeConfigurationMaintenanceRuntimeTree(authority),
          ),
        ) ||
      canonicalJson(owner) !== canonicalJson(readOwnedConfigurationMaintenance(authority))
    )
      throw Error("Original applied runtime source changed");
    signal.throwIfAborted();
    const identity = configurationOwnerIdentitySchema.parse({
        installationId: owner.installationId,
        origin: owner.origin,
        ownerPrepare: owner.plan.prepare,
        admissionDigest: owner.admissionDigest,
        rootCertificateDigest: owner.rootCertificateDigest,
        maintenanceId: owner.plan.operation.maintenanceId,
        candidateId: owner.plan.operation.candidateId,
        planDigest: owner.plan.planDigest,
      }),
      requiredChecks = configurationMaintenanceRequiredChecksSchema.parse([
        ...["generation", "owner-containers", "dm-guard"].map((check) => ({
          serviceId: null,
          ordinal: null,
          check,
          expectedRevisionId: contained
            ? owner.plan.operation.expectedCurrentRevisionId
            : owner.plan.operation.revisionId,
          expectedImageId: null,
        })),
        ...owner.plan.steps.map((step) => ({
          serviceId: null,
          ordinal: step.ordinal,
          check: "frozen-attempts",
          expectedRevisionId: owner.plan.operation.revisionId,
          expectedImageId: null,
        })),
        ...docker.checks,
      ]),
      details = [
        {
          currentRevisionId: services.currentConfigurationGeneration(source.infraDir),
          ...(currentRelease ? { currentRelease } : {}),
        },
        { containers },
        { guard },
        ...owner.plan.steps.map((step) => ({
          children: children.children.filter((value) => value.planIndex === step.ordinal),
        })),
        ...docker.details,
      ],
      inspectionId = randomUUID(),
      signed = signControl(
        state.installation.privateKey,
        domains.inspection,
        configurationMaintenanceRuntimeInspectionSchema.parse({
          version: 2,
          identity,
          inspectionId,
          ownerSequence: owner.sequence,
          ownerSourceDigest: controlDigest(owner),
          requiredChecks,
          observations: details.map((detail, checkIndex) => ({
            checkIndex,
            passed: true,
            detail: canonicalJson(detail),
          })),
          runtime: {
            verificationId: inspectionId,
            mode: contained ? "contained" : "applied",
            requiredCheckSetDigest: finalRecordDigest(domains.inspection, requiredChecks),
            checkedAt: Date.now(),
          },
        }),
      );
    if (Buffer.byteLength(canonicalJson(signed)) > 65536)
      throw Error("Private maintenance inspection capacity");
    const freeze = <T>(input: T): T => {
        if (input && typeof input === "object") {
          for (const child of Object.values(input)) freeze(child);
          Object.freeze(input);
        }
        return input;
      },
      value = Object.freeze({}) as MaintenanceRuntimeInspection;
    runtimeInspections.set(value, Object.freeze({ authority, signed: freeze(signed) }));
    return value;
  }
  if (
    !source?.candidateSource ||
    owner.final ||
    owner.inspection ||
    !owner.preparedFence ||
    owner.receipt.state !== "authorized" ||
    owner.receipt.decision?.decision !== "abandon" ||
    !owner.apiControls.decide?.receiptDelivery ||
    owner.receipt.generation !== "not_started" ||
    owner.receipt.followUp !== "not_started" ||
    owner.apiControls.steps.length
  )
    throw Error("Conclusive unused maintenance runtime source required");
  const identity = configurationOwnerIdentitySchema.parse({
      installationId: owner.installationId,
      origin: owner.origin,
      ownerPrepare: owner.plan.prepare,
      admissionDigest: owner.admissionDigest,
      rootCertificateDigest: owner.rootCertificateDigest,
      maintenanceId: owner.plan.operation.maintenanceId,
      candidateId: owner.plan.operation.candidateId,
      planDigest: owner.plan.planDigest,
    }),
    queue = source.candidateSource;
  let lease: ReturnType<typeof restoreArtifactTargetLeaseForSettlement> | undefined,
    lock: TrustedConfigurationQueueLock | undefined;
  try {
    lock = await acquireTrustedConfigurationQueueLock({
      ...queue,
      participant: "ops-agent",
      operationKey: state.execution.operationKey,
    });
    lease = restoreArtifactTargetLeaseForSettlement(authority);
    const phaseObservations = [];
    for (const step of owner.plan.steps) {
      const publication = inspectControlChildPublication(authority, step);
      if (publication.binding !== null || publication.publication.state !== "unissued")
        throw Error("Unused runtime has attempted frozen work");
      phaseObservations.push({
        phase: step.phase,
        ordinal: step.ordinal,
        operationKey: step.operationKey,
        binding: publication.binding,
        publication: publication.publication.state,
      });
    }
    const fence = owner.plan.reservations.find((value) => value.phase === "configuration-fence"),
      fenceBinding = fence && lookupControlChildPhaseBinding(authority, fence),
      physical =
        fenceBinding &&
        inspectArtifactTargetLeaseChildSettlement(lease, fenceBinding.child.execution);
    if (
      physical?.outcome !== "committed" ||
      physical.publication !== "committed" ||
      physical.terminalReceiptDigest !==
        controlDigest({ kind: "data-configuration-fence", receipt: owner.preparedFence })
    )
      throw Error("Original prepared guard settlement unavailable");
    const candidate = await readRetainedConfigurationCandidate(
      queue,
      owner.plan.operation.candidateId,
    );
    if (
      controlDigest(candidate.record) !== owner.plan.candidateRecordDigest ||
      candidate.record.prepareOperationKey !== state.execution.operationKey ||
      candidate.snapshot.revisionId !== owner.plan.operation.revisionId
    )
      throw Error("Original unused candidate changed");
    const directories = [];
    for (const [name, path] of [
      ["queue", queue.directory],
      ["claimed", join(queue.directory, ".claimed")],
    ] as const) {
      lock.assertHeld();
      const before = await lstat(path);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        before.uid !== queue.ownerUid ||
        before.gid !== queue.ownerGid ||
        (before.mode & 0o777) !== 0o700
      )
        throw Error("Original unused queue unavailable");
      const directory = await opendir(path);
      let count = 0;
      // Dir's async iterator closes its descriptor on completion or an abrupt exit.
      for await (const entry of directory)
        if (++count > 1024 || entry.name.includes(candidate.snapshot.revisionId))
          throw Error("Unused candidate publication/claim uncertain");
      const after = await lstat(path);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.uid !== after.uid ||
        before.gid !== after.gid ||
        before.mode !== after.mode
      )
        throw Error("Original unused queue changed");
      directories.push({
        name,
        dev: before.dev,
        ino: before.ino,
        uid: before.uid,
        gid: before.gid,
        mode: before.mode & 0o777,
        entries: count,
        matchingCandidateEntries: 0,
      });
    }
    const current = services.currentConfigurationGeneration(source.infraDir),
      containers = await inspectOriginalOwnerServices(source, authority, signal);
    if (
      current !== owner.plan.operation.expectedCurrentRevisionId ||
      canonicalJson(containers) !== canonicalJson(owner.originalContainers)
    )
      throw Error("Unused runtime differs from original owned generation/containers");
    const issuedAt = Date.now(),
      witness = signControl(
        state.installation.privateKey,
        "openmapx-configuration-fence-inspect-v1",
        {
          installationId: owner.installationId,
          maintenanceId: owner.plan.operation.maintenanceId,
          candidateId: owner.plan.operation.candidateId,
          ownerCertificateDigest: owner.rootCertificateDigest,
          issuedAt,
          expiresAt: issuedAt + 15000,
        },
      ),
      guard = await inspectDataConfigurationFence(owner.plan.operation.maintenanceId, {
        transport: configurationDataManagerTransport(),
        witness: Buffer.from(canonicalJson(witness)).toString("base64url"),
        signal,
      });
    if (
      canonicalJson(guard) !== canonicalJson(owner.preparedFence) ||
      canonicalJson(readOwnedConfigurationMaintenance(authority)) !== canonicalJson(owner)
    )
      throw Error("Original unused guard/owner changed");
    signal.throwIfAborted();
    lock.assertHeld();
    const requiredChecks = configurationMaintenanceRequiredChecksSchema.parse([
        ...["generation", "owner-containers", "candidate-not-consumed", "dm-guard"].map(
          (check) => ({
            serviceId: null,
            ordinal: null,
            check,
            expectedRevisionId: owner.plan.operation.expectedCurrentRevisionId,
            expectedImageId: null,
          }),
        ),
        ...owner.plan.steps.map((step) => ({
          serviceId: null,
          ordinal: step.ordinal,
          check: "frozen-attempts",
          expectedRevisionId: owner.plan.operation.revisionId,
          expectedImageId: null,
        })),
      ]),
      details = [
        { currentRevisionId: current },
        { containers },
        {
          candidateId: candidate.record.candidateId,
          revisionId: candidate.snapshot.revisionId,
          recordDigest: controlDigest(candidate.record),
          directories,
        },
        { guard },
        ...phaseObservations,
      ],
      inspectionId = randomUUID(),
      checkedAt = Date.now(),
      payload = configurationMaintenanceRuntimeInspectionSchema.parse({
        version: 2,
        identity,
        inspectionId,
        ownerSequence: owner.sequence,
        ownerSourceDigest: controlDigest(owner),
        requiredChecks,
        observations: details.map((detail, checkIndex) => ({
          checkIndex,
          passed: true,
          detail: canonicalJson(detail),
        })),
        runtime: {
          verificationId: inspectionId,
          mode: "unused",
          requiredCheckSetDigest: finalRecordDigest(domains.inspection, requiredChecks),
          checkedAt,
        },
      }),
      signed = signControl(state.installation.privateKey, domains.inspection, payload);
    if (Buffer.byteLength(canonicalJson(signed)) > 65536)
      throw Error("Private maintenance inspection capacity");
    const value = Object.freeze({}) as MaintenanceRuntimeInspection;
    const freezeProof = <T>(input: T): T => {
      if (input && typeof input === "object") {
        for (const child of Object.values(input)) freezeProof(child);
        Object.freeze(input);
      }
      return input;
    };
    runtimeInspections.set(value, Object.freeze({ authority, signed: freezeProof(signed) }));
    return value;
  } finally {
    lock?.release();
    if (lease) closeArtifactTargetLeaseHandle(lease);
  }
}
declare const unconsumedBrand: unique symbol;
export type UnconsumedMaintenanceCandidate = Readonly<{ [unconsumedBrand]: true }>;
const unconsumed = new WeakMap<
  UnconsumedMaintenanceCandidate,
  {
    authority: VerifiedExecutionAuthority;
    lock: TrustedConfigurationQueueLock;
    ownerPayloadDigest: string;
    candidateRecordDigest: string;
  }
>();
export function unconsumedMaintenanceCandidateState(
  value: UnconsumedMaintenanceCandidate,
  authority: VerifiedExecutionAuthority,
) {
  const state = unconsumed.get(value);
  if (!state || state.authority !== authority)
    throw Error("Live fixed unconsumed candidate observation required");
  executionAuthorityState(authority);
  state.lock.assertHeld();
  return state;
}
/** The callback is fixed internal synchronous publication work. Its proof is
 * invalid outside the existing real queue ownership, including after expiry.
 * Historical seal authentication here never opens a forward/apply payload. */
export async function withUnconsumedMaintenanceCandidate(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
  publish: (witness: UnconsumedMaintenanceCandidate) => void,
): Promise<void> {
  const source = sources.get(runtime),
    owner = readOwnedConfigurationMaintenance(authority),
    state = executionAuthorityState(authority);
  if (
    !source?.candidateSource ||
    state.kind !== "configurationMaintenance.prepare" ||
    owner.preparedFence ||
    owner.receipt.dmFence ||
    owner.receipt.decision?.decision === "continue" ||
    owner.receipt.generation !== "not_started"
  )
    throw Error("Original never-applied candidate owner required");
  const queue = source.candidateSource,
    lock = await acquireTrustedConfigurationQueueLock({
      ...queue,
      participant: "ops-agent",
      operationKey: state.execution.operationKey,
    });
  let witness: UnconsumedMaintenanceCandidate | undefined;
  try {
    const candidate = await readRetainedConfigurationCandidate(
        queue,
        owner.plan.operation.candidateId,
      ),
      candidateRecordDigest = controlDigest(candidate.record);
    if (
      candidateRecordDigest !== owner.plan.candidateRecordDigest ||
      candidate.record.prepareOperationKey !== state.execution.operationKey ||
      candidate.record.maintenanceId !== owner.plan.operation.maintenanceId ||
      candidate.record.operationKey !== owner.plan.operation.applyOperationKey ||
      candidate.snapshot.revisionId !== owner.plan.operation.revisionId ||
      candidate.snapshot.operationFingerprint !== owner.plan.operation.applyOperationFingerprint ||
      candidate.record.apiJobId !== owner.receipt.apiJobId ||
      candidate.record.parentOperationKey !== owner.receipt.parentOperationKey ||
      candidate.record.parentFingerprint !== owner.receipt.parentFingerprint ||
      candidate.record.parentDeadlineAt !== owner.receipt.parentDeadlineAt
    )
      throw Error("Original retained maintenance candidate changed");
    for (const path of [queue.directory, join(queue.directory, ".claimed")]) {
      lock.assertHeld();
      const before = await lstat(path);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        before.uid !== queue.ownerUid ||
        before.gid !== queue.ownerGid ||
        (before.mode & 0o777) !== 0o700
      )
        throw Error("Original candidate queue unavailable");
      const dir = await opendir(path);
      let entries = 0;
      // Dir's async iterator owns close on success and on thrown refusal.
      for await (const entry of dir) {
        if (++entries > 1024 || entry.name.includes(candidate.snapshot.revisionId))
          throw Error("Candidate publication/claim requires retained observation");
      }
      const after = await lstat(path);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.uid !== after.uid ||
        before.gid !== after.gid ||
        before.mode !== after.mode
      )
        throw Error("Original candidate queue changed during observation");
    }
    lock.assertHeld();
    if (canonicalJson(readOwnedConfigurationMaintenance(authority)) !== canonicalJson(owner))
      throw Error("Original owner changed during candidate observation");
    witness = Object.freeze({}) as UnconsumedMaintenanceCandidate;
    unconsumed.set(
      witness,
      Object.freeze({
        authority,
        lock,
        ownerPayloadDigest: controlDigest(owner),
        candidateRecordDigest,
      }),
    );
    publish(witness);
    lock.assertHeld();
  } finally {
    if (witness) unconsumed.delete(witness);
    lock.release();
  }
}
/** Only the actual production factory supplies this source; no handler/result
 * predicate or inspector can be registered by a request. */
export function registerConfigurationMaintenanceSource(runtime: OpsRuntime, source: Source): void {
  if (sources.has(runtime)) throw Error("Configuration maintenance source already installed");
  sources.set(runtime, source);
  runtime["configurationMaintenance.decide"] = async (operation, context) => {
    // Acceptance is the fixed original-owner metadata CAS during authenticated
    // admission. This worker only observes its exact immutable result.
    return inspectConfigurationMaintenanceDecisionControl(
      context.configurationMaintenanceControl!,
      operation,
      context.execution,
    ).receipt;
  };
  runtime["configurationMaintenance.settle"] = async (operation, context) => {
    const control = configurationMaintenanceControlOwnerState(
        context.configurationMaintenanceControl,
        operation,
        context.execution.operationKey,
      ),
      authority = control.authority,
      owner = readOwnedConfigurationMaintenance(authority);
    if (owner.apiControls.settle?.result)
      return inspectConfigurationMaintenanceSettleControl(
        context.configurationMaintenanceControl!,
        operation,
        context.execution,
      ).receipt;
    if (!owner.final) {
      const inspection = await inspectFrozenMaintenanceRuntime(runtime, authority, context.signal);
      finalizeOwnedMaintenanceState(authority, inspection);
    } else restoreOwnedMaintenanceFinal(authority);
    await settleOwnedConfigurationFence(authority, context.signal);
    await releaseOwnedConfigurationMaintenanceRoot(authority);
    return completeConfigurationMaintenanceSettleControl(
      context.configurationMaintenanceControl!,
      operation,
      context.execution,
    );
  };
  runtime["configurationMaintenance.inspect"] = async (operation, context) => {
    const control = configurationMaintenanceControlOwnerState(
        context.configurationMaintenanceControl,
        operation,
        context.execution.operationKey,
      ),
      authority = control.authority,
      state = executionAuthorityState(authority);
    let owner = readOwnedConfigurationMaintenance(authority);
    context.signal.throwIfAborted();
    if (owner.plan.handoff && owner.receipt.followUp !== "complete") {
      try {
        await observeOwnedConfigurationHandoff(authority);
      } catch {
        /* Unfinished/unknown helpers retain all fences. */
      }
      owner = readOwnedConfigurationMaintenance(authority);
    }
    if (owner.final && owner.apiControls.settle?.result === null) {
      try {
        await settleOwnedConfigurationFence(authority, context.signal);
        await releaseOwnedConfigurationMaintenanceRoot(authority);
        completeObservedConfigurationMaintenanceSettlement(authority);
      } catch {
        /* An unanswered settle keeps the root held. */
      }
      owner = readOwnedConfigurationMaintenance(authority);
    }
    if (owner.receipt.state === "settled" && !owner.preparedFence) {
      assertConfigurationMaintenanceRootClosure(authority);
      verifyRetainedArtifactTargetRootRelease(authority);
    }
    if (owner.receipt.state === "settled" && owner.preparedFence) {
      restoreOwnedMaintenanceFinal(authority);
      assertConfigurationMaintenanceRootClosure(authority);
      verifyRetainedArtifactTargetRootRelease(authority);
    }
    let preflight: "current" | "drifted" | "unavailable" = "unavailable";
    try {
      const fresh = configurationMaintenanceAdmissionState(
        await prepareConfigurationMaintenanceAdmission(runtime, {
          installation: state.installation.installation,
          execution: owner.plan.prepare,
          operation: owner.plan.operation,
          apiParent: owner.plan.apiParent,
          signal: context.signal,
          ...(owner.receipt.dmFence && owner.plan.release
            ? { frozenRelease: owner.plan.release }
            : {}),
        }),
      );
      preflight =
        canonicalJson(fresh.plan) === canonicalJson(owner.plan) &&
        canonicalJson(fresh.originalContainers) === canonicalJson(owner.originalContainers)
          ? "current"
          : "drifted";
      if (owner.receipt.dmFence) {
        if (!owner.preparedFence) throw Error("Original prepared guard source unavailable");
        const issuedAt = Date.now(),
          witness = signControl(
            state.installation.privateKey,
            "openmapx-configuration-fence-inspect-v1",
            {
              installationId: owner.installationId,
              maintenanceId: owner.plan.operation.maintenanceId,
              candidateId: owner.plan.operation.candidateId,
              ownerCertificateDigest: owner.rootCertificateDigest,
              issuedAt,
              expiresAt: Math.min(context.execution.deadlineAt, issuedAt + 15000),
            },
          ),
          actual = await inspectDataConfigurationFence(owner.plan.operation.maintenanceId, {
            transport: configurationDataManagerTransport(),
            witness: Buffer.from(canonicalJson(witness)).toString("base64url"),
            signal: context.signal,
          });
        if (canonicalJson(actual) !== canonicalJson(owner.receipt.dmFence))
          throw Error("Original prepared guard source changed");
      }
    } catch (error) {
      preflight = "unavailable";
      if (
        error instanceof Error &&
        /Host sources changed|preflight drifted|Settled ready coordinator/.test(error.message)
      )
        preflight = "drifted";
    }
    context.signal.throwIfAborted();
    const current = readOwnedConfigurationMaintenance(authority);
    if (canonicalJson(current) !== canonicalJson(owner)) preflight = "unavailable";
    return { ...current.receipt, preflight };
  };
  runtime["configurationMaintenance.prepare"] = async (operation, context) => {
    const authority = context.controlAuthority,
      lease = context.ownedTargetLease;
    if (!authority || !lease) throw Error("Actual original maintenance owner required");
    const state = executionAuthorityState(authority),
      owner = readOwnedConfigurationMaintenance(authority),
      plan = owner.plan;
    try {
      if (
        owner.receipt.state !== "preparing" ||
        canonicalJson(operation) !== canonicalJson(plan.operation)
      )
        throw Error("Original preparing maintenance identity required");
      // Repeat source/TTL/current/ready/registry checks after acquiring the full
      // original target closure, before any grant/DM logical reservation.
      const current = await prepareConfigurationMaintenanceAdmission(runtime, {
        installation: state.installation.installation,
        execution: state.execution,
        operation,
        apiParent: plan.apiParent,
        signal: context.signal,
      });
      if (
        canonicalJson(configurationMaintenanceAdmissionState(current).plan) !== canonicalJson(plan)
      )
        throw Error("Frozen maintenance source changed under ownership");
      const reserved = plan.reservations.find((value) => value.phase === "configuration-fence");
      if (!reserved) throw Error("Original DM preparation reservation required");
      const previous = lookupControlChildPhaseBinding(authority, reserved),
        child = await bindControlChildPhase(authority, reserved);
      let assertion: string | undefined;
      if (!previous) {
        const issued = await issueControlChildPhase(authority, {
          phase: reserved.phase,
          ordinal: reserved.ordinal,
          lease,
          childPublicKey: controlRolePublicKey(state.installation.installation, "data-manager"),
        });
        consumeControlChildDispatch(issued.dispatchTicket);
        assertion = issued.assertion;
      } else assertion = lookupControlChildPhaseAttempt(authority, reserved)?.assertion;
      if (!assertion) throw new OpsExecutionFailure("recovery_required", {});
      try {
        // The data-manager prepares idempotently: a lost reply repeats the same body.
        const receipt = await retryDataManager(context.signal, () =>
          prepareDataConfigurationFence(plan.dmPrepare, {
            transport: configurationDataManagerTransport(),
            controlAssertion: assertion,
            signal: context.signal,
          }),
        );
        recordOwnedConfigurationMaintenancePrepared(
          authority,
          lease,
          owner.sequence,
          child.execution,
          receipt,
        );
      } catch {
        throw new OpsExecutionFailure("recovery_required", {});
      }
      return readOwnedConfigurationMaintenance(authority).receipt;
    } catch (error) {
      try {
        retainConfigurationFenceNotPrepared(authority);
      } catch {
        /* A prepared or unknown fence keeps this root held. */
      }
      throw error;
    }
  };
}
export function configurationMaintenanceAdmissionState(
  value: ConfigurationMaintenanceAdmission,
): AdmissionState {
  const state = admissions.get(value);
  if (!state) throw Error("Actual configuration maintenance admission required");
  return state;
}
export async function prepareConfigurationMaintenanceAdmission(
  runtime: OpsRuntime,
  input: {
    installation: ControlInstallation;
    execution: ExecutionRef;
    operation: ConfigurationMaintenancePrepare;
    apiParent: RetainedParentExecution;
    signal: AbortSignal;
    /** Once maintenance holds the data fence, the release was already resolved
     * and downloaded. Re-checks then use the frozen snapshot and local images
     * only, never the registry. */
    frozenRelease?: ConfigurationReleaseSnapshot;
  },
): Promise<ConfigurationMaintenanceAdmission> {
  const source = sources.get(runtime);
  if (
    !source?.candidateSource ||
    input.installation.role !== "ops-agent" ||
    input.apiParent.issuer !== "api"
  )
    throw Error("Original API configuration maintenance source required");
  input.signal.throwIfAborted();
  const candidate = await readConfigurationCandidate(
      source.candidateSource,
      input.operation.candidateId,
    ),
    original = candidate.operation;
  if (
    candidate.record.apiJobId !== input.apiParent.apiJobId ||
    candidate.record.parentOperationKey !== input.apiParent.operationKey ||
    candidate.record.parentFingerprint !== input.apiParent.fingerprint ||
    candidate.record.parentDeadlineAt !== input.apiParent.deadlineAt ||
    candidate.record.maintenanceId !== input.operation.maintenanceId ||
    candidate.record.prepareOperationKey !== input.execution.operationKey ||
    candidate.record.operationKey !== input.operation.applyOperationKey ||
    opsOperationFingerprint(original) !== input.operation.applyOperationFingerprint ||
    !("revisionId" in original) ||
    !("expectedCurrentRevisionId" in original) ||
    !("expectedSourceRevision" in original) ||
    !("coordinatorMode" in original) ||
    original.revisionId !== input.operation.revisionId ||
    original.expectedCurrentRevisionId !== input.operation.expectedCurrentRevisionId ||
    original.expectedSourceRevision !== input.operation.expectedSourceRevision ||
    original.coordinatorMode !== input.operation.coordinatorMode ||
    ![
      "stack.render",
      "serviceSelection.apply",
      "serviceConfig.apply",
      "integrationConfig.apply",
      "vault.apply",
    ].includes(original.kind)
  )
    throw Error("Original candidate/parent maintenance binding conflict");
  const platform = candidate.record.privatePlatformIntent;
  if (
    platform &&
    (candidate.record.apiFollowUp !== "platform-apply" ||
      original.kind !== "stack.render" ||
      platform.sourceRevision !== input.operation.expectedSourceRevision ||
      platform.expectedCurrentRevisionId !== input.operation.expectedCurrentRevisionId ||
      canonicalJson(platform.configuration) !== canonicalJson(candidate.payload.platform) ||
      canonicalJson(platform.affectedServiceIds) !==
        canonicalJson(candidate.record.affectedServiceIds))
  )
    throw Error("Original platform candidate binding conflict");
  const release = platform?.release
    ? input.frozenRelease
      ? await verifyFrozenConfigurationRelease({
          infraDir: source.infraDir,
          selection: platform.release,
          frozen: input.frozenRelease,
          execFile: source.execFile,
          signal: input.signal,
        })
      : await preflightConfigurationRelease({
          infraDir: source.infraDir,
          selection: platform.release,
          execFile: source.execFile,
          signal: input.signal,
        })
    : undefined;
  const recreateServiceIds = release
    ? []
    : platform
      ? candidate.record.affectedServiceIds.filter(
          (id) => !protectedConfigurationServiceIdSchema.safeParse(id).success,
        )
      : candidate.record.apiFollowUp === "service-apply" ||
          candidate.record.privateCoordinatorLifecycle ||
          candidate.record.privateIntegrationReload?.stagedMigration
        ? candidate.record.affectedServiceIds
        : [];
  if (
    (platform ? "platform-apply" : recreateServiceIds.length ? "service-apply" : "render-only") !==
    input.operation.followUp
  )
    throw Error("Configuration maintenance continuation unavailable");
  const authority = await source.loadAuthority();
  const coordinator = candidate.record.privateCoordinatorLifecycle
    ? renderCoordinatorCandidate(candidate, authority, source.infraDir)
    : undefined;
  if (coordinator)
    verifyConfigurationReleaseSourceWitness({
      installation: input.installation,
      infraDir: source.infraDir,
      sourceRevision: input.operation.expectedSourceRevision,
      expectedCurrentRevisionId: input.operation.expectedCurrentRevisionId,
      authorityRevision: authority.revisionId,
    });
  verifyConfigurationSourceWitness({
    installation: input.installation,
    infraDir: source.infraDir,
    sourceRevision: input.operation.expectedSourceRevision,
    expectedCurrentRevisionId: input.operation.expectedCurrentRevisionId,
    authorityRevision: authority.revisionId,
  });
  const desired = services.readDesiredSelection(source.infraDir);
  const rendered = services.renderConfiguration({
    infraDir: source.infraDir,
    services: authority.services,
    integrationSchemas: authority.integrationSchemas,
    input: {
      ...candidate.payload,
      selectedRoots: candidate.payload.selectedRoots ?? desired.roots,
    },
    allowMissingSelected: !candidate.payload.selectedRoots && desired.source === "default",
  });
  const prospective = new Set(rendered.resolved.enabled.map((service) => service.manifest.id));
  if (!prospective.has("data-manager") || recreateServiceIds.some((id) => !prospective.has(id)))
    throw Error("Configuration maintenance coordinator/target prerequisite unavailable");
  const current = services.readAppliedServiceIds(source.infraDir, authority.services);
  if (!current) throw Error("Current configuration generation required for maintenance");
  const serviceIds = [
    ...new Set([
      ...current,
      ...prospective,
      ...candidate.record.affectedServiceIds,
      "data-manager",
    ]),
  ].sort();
  const plan = rendered.rendered.hardlinkPlan;
  if (plan.length && input.operation.coordinatorMode === "ensure-running" && !coordinator) {
    if (
      !input.operation.expectedCurrentRevisionId ||
      candidate.record.coordinatorPrerequisite?.operation.expectedConfigurationRevisionId !==
        input.operation.expectedCurrentRevisionId
    )
      throw Error("Original settled old-revision coordinator prerequisite required");
    verifyMaintenanceCoordinatorPrerequisite(input.installation, candidate.record);
  }
  let coordinatorPull: CoordinatorPullWitness | undefined,
    coordinatorBaseline: VerifiedCoordinatorPullBaseline | undefined,
    coordinatorImage: FixedConfigurationMaintenancePlan["coordinatorImage"];
  if (coordinator) {
    const fixed = coordinatorCandidateMetadata(candidate.record);
    // A used helper remains an exact settled original. An already-ready old
    // coordinator needs no Compose up and is observed again above.
    const helper = candidate.record.coordinatorPrerequisite;
    if (helper) {
      let present = false;
      try {
        readPrivateRecord(
          installationState(input.installation),
          "executions",
          `${helper.root.operationKey}.json`,
          65536,
        );
        present = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (present) verifyMaintenanceCoordinatorPrerequisite(input.installation, candidate.record);
    }
    if (fixed.action === "update") {
      let retained: ConfigurationMaintenanceOwnerRecord | undefined;
      try {
        const originalOwner = restoreAdmittedControlExecution(input.installation, input.execution);
        retained = readOwnedConfigurationMaintenance(originalOwner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (retained) {
        coordinatorPull = retained.coordinatorPull;
        coordinatorBaseline = ownedCoordinatorPullBaseline(
          restoreAdmittedControlExecution(input.installation, input.execution),
        );
      } else {
        const matches = journals
          .get(runtime)
          ?.records()
          .filter((job) => job.role === "api" && job.operationKey === fixed.pull.operationKey);
        if (!matches || matches.length !== 1)
          throw Error("Unique original coordinator pull source unavailable");
        const job = matches[0]!;
        if (
          job.operation.kind !== "service.pull" ||
          job.state !== "succeeded" ||
          canonicalJson(job.operation) !== canonicalJson(fixed.pull.operation)
        )
          throw Error("Actual successful current coordinator pull required");
        const status = parseOpsJobStatus({
          version: 2,
          admittedAt: job.admittedAt,
          deadlineAt: job.deadlineAt,
          fingerprint: job.fingerprint,
          operationId: job.operationId,
          operationKey: job.operationKey,
          kind: job.operation.kind,
          resourceId: job.resourceId,
          state: job.state,
          submittedAt: job.submittedAt,
          updatedAt: job.updatedAt,
          result: job.result,
          ...(job.terminationRequestedAt
            ? { terminationRequestedAt: job.terminationRequestedAt }
            : {}),
        });
        coordinatorPull = observeCoordinatorPullForMaintenance(
          input.installation,
          candidate.record,
          input.execution,
          status,
        );
        coordinatorBaseline = observedCoordinatorPullBaseline(coordinatorPull);
      }
      const proof =
        coordinatorPull &&
        verifyControl(
          input.installation.publicKey,
          coordinatorPullObservationDomain,
          coordinatorPull,
          coordinatorPullWitnessPayloadSchema,
        );
      if (
        !proof ||
        proof.imageReference !== coordinator.imageReference ||
        proof.releaseSelectionDigest !== coordinator.releaseSelectionDigest ||
        proof.submissionDigest !== coordinatorPullSubmissionDigest(fixed.pull)
      )
        throw Error("Original pulled coordinator image source changed");
      coordinatorImage = {
        action: "update",
        noDeps: fixed.noDeps,
        imageReference: proof.imageReference,
        imageId: proof.imageId,
        releaseSelectionDigest: proof.releaseSelectionDigest,
        pullSubmissionDigest: proof.submissionDigest,
      };
    } else {
      const observed = await source.execFile(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", coordinator.imageReference],
        { signal: input.signal, timeout: 15000, maxBuffer: 4096 },
      );
      coordinatorImage = {
        action: "apply",
        noDeps: false,
        imageReference: coordinator.imageReference,
        imageId: observed.stdout.trim(),
        releaseSelectionDigest: coordinator.releaseSelectionDigest,
        pullSubmissionDigest: null,
      };
    }
  }
  if (!coordinator && recreateServiceIds.includes("data-manager")) {
    verifyConfigurationReleaseSourceWitness({
      installation: input.installation,
      infraDir: source.infraDir,
      sourceRevision: input.operation.expectedSourceRevision,
      expectedCurrentRevisionId: input.operation.expectedCurrentRevisionId,
      authorityRevision: authority.revisionId,
    });
    const selected = services.readServiceReleaseImageSelection(source.infraDir, "data-manager"),
      imageReference =
        selected.imageReference ??
        services.configurationImageReference(rendered.rendered.composeYaml, "data-manager");
    const actual = await source.execFile(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", imageReference],
      { signal: input.signal, timeout: 15000, maxBuffer: 4096 },
    );
    coordinatorImage = {
      action: "apply",
      noDeps: false,
      imageReference,
      imageId: actual.stdout.trim(),
      releaseSelectionDigest: selected.releaseSelectionDigest,
      pullSubmissionDigest: null,
    };
  }
  const staged =
    !coordinatorBaseline && recreateServiceIds.includes("data-manager")
      ? await inspectStagedCoordinatorMaintenanceSource(source.ownedServices, input.signal)
      : undefined;
  const originalContainers = coordinatorBaseline
    ? await inspectOriginalCoordinatorServices(
        source.ownedServices,
        coordinatorBaseline,
        input.signal,
      )
    : (staged?.services ?? (await source.ownedServices.inspectOwnedServices(input.signal)));
  if (
    originalContainers.find((service) => service.serviceId === "data-manager")?.state !== "running"
  )
    throw Error("Settled ready coordinator prerequisite required before maintenance");
  await assertConfigurationCoordinatorReady(input.signal);
  const previewDigest = createHash("sha256")
    .update("openmapx-configuration-hardlinks-preview-v1\0")
    .update(
      canonicalJson({
        candidateId: input.operation.candidateId,
        revisionId: input.operation.revisionId,
        expectedSourceRevision: input.operation.expectedSourceRevision,
        coordinatorMode: input.operation.coordinatorMode,
        plan,
      }),
    )
    .digest("hex");
  if (release) {
    const targets = rendered.resolved.enabled
      .map((entry) => entry.manifest.id)
      .filter((id) => Object.hasOwn(release.serviceImages, id))
      .sort();
    if (canonicalJson(targets) !== canonicalJson(platform!.affectedServiceIds))
      throw Error("Exact enabled checked release targets required");
  }
  const protectedIds = release
    ? platform!.affectedServiceIds
    : platform
      ? platform.affectedServiceIds.filter(
          (id) => protectedConfigurationServiceIdSchema.safeParse(id).success,
        )
      : [];
  const handoff =
    platform && protectedIds.length
      ? {
          handoffId: platform.handoffId,
          previewFingerprint: platform.previewFingerprint,
          serviceIds: protectedIds,
          expectedImageIdentities: Object.fromEntries(
            protectedIds.map((id) => {
              const old = originalContainers.find((value) => value.serviceId === id);
              if (
                !old ||
                (release && !["running", "stopped", "created"].includes(old.state)) ||
                (!release && old.state !== "running") ||
                (release && ["data-manager", "ops-agent"].includes(id) && old.state !== "running")
              )
                throw Error("Original handoff target unavailable");
              return [id, old.provenance.imageId];
            }),
          ),
          mode: release
            ? {
                kind: "release" as const,
                releaseId: release.releaseId,
                manifestDigest: release.manifestDigest,
              }
            : { kind: "configuration" as const },
        }
      : undefined;
  const frozen = buildFixedConfigurationMaintenancePlan({
    installationId: input.installation.installationId,
    prepare: input.execution,
    operation: input.operation,
    apiParent: input.apiParent,
    apply: original as Parameters<typeof buildFixedConfigurationMaintenancePlan>[0]["apply"],
    candidateRecordDigest: createHash("sha256")
      .update(canonicalJson(candidate.record))
      .digest("hex"),
    sourceAuthorityRevision: authority.revisionId,
    previewDigest,
    hardlinkPlan: { plan, prune: true },
    serviceIds,
    recreateServiceIds,
    ...(handoff ? { handoff } : {}),
    ...(release ? { release } : {}),
    ...(coordinatorImage ? { coordinatorImage } : {}),
  });
  assertProspectiveConfigurationMaintenanceBudget({
    ...(release
      ? {
          releaseSourceBytes: Buffer.byteLength(
            canonicalJson({
              overlay: readConfigurationHandoffReleaseOverlay(source.infraDir),
              state: readConfigurationHandoffReleaseState(source.infraDir),
            }),
          ),
        }
      : {}),
    installationId: input.installation.installationId,
    plan: frozen,
    originalContainers: structuredClone(originalContainers),
    rendered,
  });
  if (
    (await source.loadAuthority()).revisionId !== authority.revisionId ||
    services.currentConfigurationGeneration(source.infraDir) !==
      input.operation.expectedCurrentRevisionId
  )
    throw Error("Configuration maintenance preflight drifted");
  const stagedSource = staged?.proof && verifiedStagedCoordinatorOwnershipState(staged.proof);
  if (
    stagedSource &&
    (coordinatorPull ||
      stagedSource.installationId !== input.installation.installationId ||
      stagedSource.source.baseline.configurationRevisionId !==
        input.operation.expectedCurrentRevisionId)
  )
    throw Error("Original staged maintenance source changed");
  const stagedCoordinatorProvenance = stagedSource
    ? stagedCoordinatorObservationSchema.parse(
        signControl(
          installationState(input.installation).privateKey,
          stagedCoordinatorObservationDomain,
          {
            version: 1,
            installationId: input.installation.installationId,
            ownerPrepare: input.execution,
            candidateId: input.operation.candidateId,
            planDigest: frozen.planDigest,
            source: stagedSource.source,
            capturedAt: Date.now(),
          },
        ),
      )
    : undefined;
  const value = Object.freeze({}) as ConfigurationMaintenanceAdmission;
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  admissions.set(
    value,
    freeze({
      plan: frozen,
      originalContainers: structuredClone(originalContainers),
      ...(coordinatorPull ? { coordinatorPull } : {}),
      ...(stagedCoordinatorProvenance ? { stagedCoordinatorProvenance } : {}),
    }),
  );
  return value;
}

async function inspectOriginalOwnerServices(
  source: NonNullable<ReturnType<typeof sources.get>>,
  authority: VerifiedExecutionAuthority,
  signal: AbortSignal,
) {
  const owner = readOwnedConfigurationMaintenance(authority);
  return owner.plan.coordinatorImage?.action === "update"
    ? inspectOriginalCoordinatorServices(
        source.ownedServices,
        ownedCoordinatorPullBaseline(authority),
        signal,
      )
    : owner.stagedCoordinatorProvenance
      ? inspectStagedCoordinatorOwnerServices(
          source.ownedServices,
          ownedStagedCoordinatorBaseline(authority),
          signal,
        )
      : source.ownedServices.inspectOwnedServices(signal);
}
