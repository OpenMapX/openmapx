/** One execution as its role recorded it: the admitted operation, its
 * lifecycle, its effect start and settlement, and the children it reserved. */
import { randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PreparedConfigurationRecord } from "../ops/configuration-preparation";
import {
  type OpsJobStatus,
  type OpsOperationKind,
  opsOperationSchema,
  parseBoundedOpsResult,
  parseOpsJobStatus,
} from "../ops/contract";
import { type ControlExecutionOrigin, parseControlRootOperationKey } from "../ops/control-root-key";
import { controlTerminalReceiptDigest } from "../ops/control-terminal-receipt";
import { coordinatorPullSubmissionDigest } from "../ops/coordinator-lifecycle-records";
import {
  type ControlIssuer,
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
  normalizeExecutionAdmission,
  opsExecutionBudget,
  opsExecutionMaximumMs,
  type RetainedParentExecution,
  retainedParentExecutionSchema,
} from "../ops/execution-identity";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { dataWorkflowReceiptSchema } from "../ops/job-evidence";
import { servicePullResultSchema } from "../ops/service-operation-records";
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
import {
  currentConfigurationGeneration,
  type OriginalConfigurationGenerationNonCommit,
  originalConfigurationGenerationNonCommitSource,
} from "../services/configuration-generation";
import { dataConfigurationFenceReceiptSchema } from "../services/data-manager/contracts/configuration-maintenance";
import {
  type DataControlDelegation,
  dataControlDelegationSchema,
  dataExecutionStatusSchema,
  LOCAL_DATA_EXECUTION_KINDS,
} from "../services/data-manager/contracts/executions";
import type { DataManagerTransport } from "../services/data-manager/transport";
import {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  digest,
  type InstallationState,
  targetSchema,
  uuid,
} from "./control-records";
import {
  type CoordinatorPullBaseline,
  coordinatorPullBaselineSchema,
  coordinatorPullWitnessPayloadSchema,
  coordinatorPullWitnessSchema,
  stagedCoordinatorObservationPayloadSchema,
  stagedCoordinatorSourceSchema,
} from "./coordinator-pull-records";
import { readDataManagerTerminal } from "./data-manager-terminal";
import { dataUpdatePlanSchema } from "./data-update-records";
import { dataUpdateSourcesDigest } from "./data-update-sources";
import { AnchoredDirectory, identity } from "./filesystem";
import {
  type ControlChildPhase,
  type ControlChildReservation,
  type ControlRecipient,
  childPhaseKinds,
  controlChildOperationKey,
  controlChildReservationSchema,
  knownSettlement,
  localLeases,
  requireLocalLeases,
  rootLeaseId,
  verifyFiniteControlEdge,
} from "./lease-store";
import {
  LOCAL_CREDENTIAL_TEMPLATE_KIND,
  localCredentialTemplateOperationSchema,
  localCredentialTemplateReceiptSchema,
} from "./local-credential-template";
import {
  MAINTENANCE_NAMESPACE,
  type MaintenanceFile,
  maintenanceFileName,
  parseMaintenanceFile,
} from "./maintenance-file";
import {
  agentStoreLeases,
  assertControlStorageAvailable,
  closeControlInstallation,
  controlPrivateRoot,
  installationState,
  readPrivateRecord,
  registerControlInstallation,
  writePrivateRecord,
} from "./private-records";

export type { ControlExecutionOrigin } from "../ops/control-root-key";

declare const authorityBrand: unique symbol,
  peerBrand: unique symbol,
  settlementBrand: unique symbol,
  recoveryBrand: unique symbol;
export type VerifiedExecutionAuthority = Readonly<{
  execution: ExecutionRef;
  [authorityBrand]: true;
}>;
export type VerifiedControlPeer = Readonly<{ [peerBrand]: true }>;
export type VerifiedChildSettlement = Readonly<{ [settlementBrand]: true }>;
export type VerifiedRecoveryAuthority = Readonly<{ [recoveryBrand]: true }>;
export type ChildSettlement = {
  identity: ExecutionRef;
  outcome: "contained" | "committed" | "failed_without_effect" | "unknown";
  publication: "not_started" | "committed" | "unknown";
  terminalReceiptDigest: string;
};

export interface ControlPlannedChild {
  phase: ControlChildPhase;
  ordinal: number;
  kind: string;
  execution: ExecutionRef;
  serviceIds: readonly string[];
  recipient: ControlRecipient;
}
const plannedChildSchema = z.strictObject({
  phase: z.enum(Object.keys(childPhaseKinds) as [ControlChildPhase, ...ControlChildPhase[]]),
  ordinal: z.number().int().min(0).max(63),
  kind: z.string().max(128),
  execution: executionRefSchema,
  serviceIds: targetSchema,
  recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
});
export interface AuthorityState {
  installation: InstallationState;
  execution: ExecutionRef;
  kind: string;
  serviceIds: readonly string[];
  plan: readonly ControlPlannedChild[];
  reservations: readonly ControlChildReservation[];
  receiptDigest: string;
  origin: ControlExecutionOrigin;
}
const authorities = new WeakMap<object, AuthorityState>();
export function executionAuthorityState(value: VerifiedExecutionAuthority) {
  const s = authorities.get(value);
  if (!s) throw Error("Unverified execution authority");
  s.installation.privateRoot.check();
  const current = readPrivateRecord(
    s.installation,
    `executions`,
    `${s.execution.operationKey}.json`,
    65536,
  );
  if (controlDigest(current) !== s.receiptDigest)
    throw Error("Durable execution authority changed");
  return s;
}
export function retainedExecutionOrigin(
  state: InstallationState,
  execution: ExecutionRef,
): ControlExecutionOrigin {
  const raw = readPrivateRecord(state, "executions", `${execution.operationKey}.json`, 65536);
  const admitted = z
    .object({
      version: z.literal(2),
      execution: executionRefSchema,
      origin: controlOriginSchema,
    })
    .passthrough()
    .parse(raw);
  if (controlDigest(execution) !== controlDigest(admitted.execution))
    throw Error("Execution origin identity mismatch");
  return admitted.origin;
}
/** Fixed adapters call after their own durable admission, passing the complete typed operation, never only its IDs. */
export function retainAdmittedControlExecution(
  installation: ControlInstallation,
  input: {
    execution: ExecutionRef;
    kind: string;
    operation: unknown;
    admittedAt: number;
    requestedDeadlineAt?: number;
    parent?: RetainedParentExecution;
    /** The child row this execution runs as, under another holder's lease. */
    leaseChild?: LeaseChildRef;
    serviceIds: readonly string[];
    plan?: readonly ControlPlannedChild[];
    reservations?: readonly ControlChildReservation[];
    coordinatorPullBaseline?: CoordinatorPullBaseline;
  },
): VerifiedExecutionAuthority {
  const state = installationState(installation);
  if (input.leaseChild) leaseChildRefSchema.parse(input.leaseChild);
  const execution = Object.freeze(executionRefSchema.parse(input.execution));
  const serviceIds = targetSchema.parse(input.serviceIds);
  if (
    (execution.executor !== installation.role &&
      !(state.fixedChildId && execution.executor === "host-cli")) ||
    serviceIds.some((id) => !state.registeredTargets.has(id))
  )
    throw Error("Unregistered execution role/targets");
  const parsed = opsOperationSchema.safeParse(input.operation);
  if (parsed.success) {
    if (
      parsed.data.kind !== input.kind ||
      opsOperationFingerprint(parsed.data) !== execution.operationFingerprint
    )
      throw Error("Admitted operation body mismatch");
  } else if (
    ![
      "transit-sync",
      "download-osm",
      "download-fonts",
      "convert-overpass",
      "overture-sync",
      "overture-pull",
      "overture-ingest",
      "overture-extract",
      "overture-conflate",
      "search-index-build",
      "notable-places-build",
      "catalog.activate",
      "catalog.validate",
      "catalog-pins.initialize",
      LOCAL_CREDENTIAL_TEMPLATE_KIND,
      "artifactTransfer.import",
      "artifactTransfer.export",
      "artifactTransfer.validate",
      "transit-maintenance",
      ...LOCAL_DATA_EXECUTION_KINDS,
      "generation-hardlinks",
      "configuration-maintenance.prepare",
      "configuration-maintenance.settle",
      "configurationMaintenance.prepare",
      "configurationHandoff.prepare",
      "configuration-helper",
    ].includes(input.kind) ||
    controlDigest(input.operation) !== execution.operationFingerprint
  )
    throw Error("Unsupported fixed control operation");
  if (
    !Number.isSafeInteger(input.admittedAt) ||
    execution.deadlineAt <= input.admittedAt ||
    execution.fingerprint !==
      executionFingerprint({
        kind: input.kind,
        operationFingerprint: execution.operationFingerprint,
        deadlineAt: execution.deadlineAt,
        ...(input.parent ? { parent: input.parent } : {}),
      })
  )
    throw Error("Immutable execution identity mismatch");
  const coordinatorPull =
    parsed.success && parsed.data.kind === "service.pull" && parsed.data.candidateId
      ? parsed.data
      : undefined;
  if (coordinatorPull || input.coordinatorPullBaseline) {
    const baseline = coordinatorPullBaselineSchema.parse(input.coordinatorPullBaseline);
    if (
      !coordinatorPull ||
      coordinatorPull.serviceId !== "data-manager" ||
      installation.role !== "ops-agent" ||
      state.fixedChildId ||
      input.parent?.issuer !== "api" ||
      input.parent.apiJobId === undefined ||
      baseline.candidateId !== coordinatorPull.candidateId ||
      baseline.configurationRevisionId !== coordinatorPull.expectedConfigurationRevisionId
    )
      throw Error("Original coordinator pull baseline required");
  }
  const plan = z
    .array(plannedChildSchema)
    .max(64)
    .parse(input.plan ?? []);
  const reservations = z
    .array(controlChildReservationSchema)
    .max(64)
    .parse(input.reservations ?? []);
  if (
    input.kind.startsWith("catalogIntegration.") &&
    (!parsed.success ||
      installation.role !== "ops-agent" ||
      state.fixedChildId ||
      execution.principal !== "api" ||
      plan.length ||
      reservations.length)
  )
    throw Error("Catalog integration requires its original agent root without children");
  validateControlChildReservations({
    role: state.fixedChildId ? "fixed-cli" : installation.role,
    kind: input.kind,
    execution,
    serviceIds,
    plan,
    reservations,
  });
  if (
    input.kind === "catalog-pins.initialize" &&
    (state.fixedChildId ||
      input.parent ||
      plan.length ||
      reservations.length ||
      serviceIds.length !== 1 ||
      serviceIds[0] !== "motis" ||
      !["ops-agent", "host-cli"].includes(installation.role) ||
      controlDigest(input.operation) !== controlDigest({ kind: "catalog-pins.initialize" }))
  )
    throw Error("Fixed local catalog bootstrap only");
  if (input.kind === LOCAL_CREDENTIAL_TEMPLATE_KIND) {
    localCredentialTemplateOperationSchema.parse(input.operation);
    if (
      state.fixedChildId ||
      input.parent ||
      plan.length ||
      reservations.length ||
      installation.role !== "host-cli" ||
      execution.principal !== "host-cli" ||
      serviceIds.length !== 1 ||
      serviceIds[0] !== "motis"
    )
      throw Error("Fixed local host credential template only");
  }
  const budget = (() => {
    try {
      return opsExecutionMaximumMs(input.kind);
    } catch {
      if (
        [
          "configurationMaintenance.prepare",
          "configurationHandoff.prepare",
          "configuration-helper",
        ].includes(input.kind)
      )
        return 3600000;
      if (input.kind === "catalog-pins.initialize") return 60000;
      if (input.kind === LOCAL_CREDENTIAL_TEMPLATE_KIND) return 300000;
      if (
        ["configuration-maintenance.prepare", "configuration-maintenance.settle"].includes(
          input.kind,
        )
      )
        return 60000;
      throw Error("Unknown control kind budget");
    }
  })();
  if (execution.deadlineAt > input.admittedAt + budget)
    throw Error("Control execution exceeds kind budget");
  if (plan.length + reservations.length > 64) throw Error("Control child intent capacity");
  const keys = new Set<string>();
  for (const child of plan) {
    executionRefSchema.parse(child.execution);
    targetSchema.parse(child.serviceIds);
    if (
      !Number.isSafeInteger(child.ordinal) ||
      keys.has(child.execution.operationKey) ||
      child.execution.operationKey !==
        controlChildOperationKey(execution.operationKey, child.phase, child.ordinal) ||
      !childPhaseKinds[child.phase]?.includes(child.kind) ||
      child.execution.deadlineAt > execution.deadlineAt ||
      child.serviceIds.some((id) => !serviceIds.includes(id))
    )
      throw Error("Invalid fixed child plan");
    keys.add(child.execution.operationKey);
  }
  if (Object.hasOwn(input, "origin"))
    throw Error("Caller-supplied origin is not verified authority");
  const existingName = `${execution.operationKey}.json`;
  let existing: unknown;
  try {
    existing = readPrivateRecord(state, "executions", existingName, 65536);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing) {
    const stored = z
      .object({
        version: z.literal(2),
        origin: controlOriginSchema,
      })
      .passthrough()
      .parse(existing);
    const { version: _version, origin: _origin, ...oldInput } = stored;
    if (
      controlDigest({ ...oldInput, reservations: oldInput.reservations ?? [] }) !==
      controlDigest({ ...input, execution, serviceIds, plan, reservations })
    )
      throw Error("Conflicting retained execution identity");
    return restoreAdmittedControlExecution(installation, execution);
  }
  let origin: ControlExecutionOrigin;
  const inherited = input.parent && verifiedParentOrigins.get(input.parent);
  if (inherited) {
    if (!input.parent || !verifiedParents.has(input.parent))
      throw Error("Unverified parent origin");
    origin = controlOriginSchema.parse(inherited);
  } else {
    if (input.parent && (input.parent.issuer !== "api" || !verifiedParents.has(input.parent)))
      throw Error("Missing signed inherited origin; legacy parent is observation-only");
    const parsed = parseControlRootOperationKey(execution.operationKey);
    const now = Date.now();
    if (parsed.notAfter <= now) throw Error("Expired control root expiry");
    if (parsed.notAfter - now > 7 * 24 * 3600_000 || input.requestedDeadlineAt !== parsed.notAfter)
      throw Error("Control root requested deadline must equal its expiry within seven days");
    origin = {
      version: 1,
      rootKey: execution.operationKey,
      issuer: execution.executor,
      notAfter: parsed.notAfter,
    };
  }
  if (execution.deadlineAt > origin.notAfter)
    throw Error("Control execution widens origin deadline");
  const receipt = {
    version: 2,
    ...input,
    execution,
    serviceIds,
    plan,
    origin,
  };
  if (Buffer.byteLength(canonicalJson(receipt)) > 65536)
    throw Error("Execution authority receipt capacity");
  const name = `${execution.operationKey}.json`;
  let newlyAdmitted = false;
  try {
    const old = readPrivateRecord(state, "executions", name, 65536);
    if (controlDigest(old) !== controlDigest(receipt))
      throw Error("Conflicting retained execution identity");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    assertControlStorageAvailable(installation);
    writePrivateRecord(state, "executions", name, receipt, true);
    writePrivateRecord(state, "effects", name, null, true);
    writePrivateRecord(state, "effect-started", name, null, true);
    newlyAdmitted = true;
  }
  const authority = Object.freeze({ execution }) as VerifiedExecutionAuthority;
  authorities.set(authority, {
    installation: state,
    execution,
    kind: input.kind,
    serviceIds,
    plan,
    reservations,
    receiptDigest: controlDigest(receipt),
    origin,
  });
  if (newlyAdmitted) initializeControlChildReservations(authority);
  initializeLifecycle(state, execution, newlyAdmitted);
  return authority;
}
export interface PeerState {
  installation: InstallationState;
  role: ControlIssuer;
  local?: boolean;
  recipient: ControlRecipient;
  execution: ExecutionRef;
  kind: string;
  leaseChild: LeaseChildRef;
}
const peers = new WeakMap<object, PeerState>();
export function controlPeerState(peer: VerifiedControlPeer) {
  const s = peers.get(peer);
  if (!s) throw Error("Unverified control peer");
  return s;
}
/** A child in the agent's lease store: the lease and the child's row. */
export type LeaseChildRef = Readonly<{ leaseId: string; childKey: string }>;
export const leaseChildRefSchema = z.strictObject({ leaseId: uuid, childKey: uuid });
/**
 * A child that a role which cannot read the lease store (data-manager) runs,
 * as its issuer states it. The caller's token says who sent it.
 */
export type ControlDelegation = DataControlDelegation;
/**
 * The child data-manager received from the agent or the host CLI. The
 * caller's token says who sent it; data-manager never reads the lease store.
 * A child without a lease runs under its parent's deadline only.
 */
export function inspectRemoteDelegation(
  installation: ControlInstallation,
  value: ControlDelegation,
  transportPrincipal: ControlTransportPrincipal,
) {
  if (installation.role !== "data-manager") throw Error("Data-manager receiver required");
  const delegation = dataControlDelegationSchema.parse(value),
    issuer = delegation.parent.executor;
  if (
    delegation.execution.executor !== "data-manager" ||
    !Object.hasOwn(childPhaseKinds, delegation.phase) ||
    !childPhaseKinds[delegation.phase as ControlChildPhase].includes(delegation.kind) ||
    delegation.execution.deadlineAt > delegation.parent.deadlineAt ||
    (delegation.leaseId === null
      ? !["osm", "transit", "fonts", "data-step"].includes(delegation.phase) ||
        delegation.targets.length !== 0 ||
        controlDigest(delegation.owner) !== controlDigest(delegation.parent)
      : delegation.targets.length === 0) ||
    !(
      (transportPrincipal === "ops-agent" && (issuer === "ops-agent" || issuer === "host-cli")) ||
      (transportPrincipal === "host-cli" && issuer === "host-cli")
    )
  )
    throw Error("Delegation caller mismatch");
  const verifiedParent = Object.freeze(
    retainedControlParent(delegation.parent),
  ) as import("../ops/execution-identity").VerifiedParentExecution;
  verifiedParents.add(verifiedParent);
  verifiedParentOrigins.set(verifiedParent, delegation.origin);
  return Object.freeze({
    delegation,
    leaseId: delegation.leaseId,
    childKey: delegation.childKey,
    owner: delegation.owner,
    origin: delegation.origin,
    parent: delegation.parent,
    verifiedParent,
    execution: delegation.execution,
    kind: delegation.kind,
    phase: delegation.phase,
    serviceIds: Object.freeze([...delegation.targets]),
  });
}
/** The caller a receiver authenticated by its own bearer token. */
export type ControlTransportPrincipal = "data-manager" | "api" | "ops-agent" | "host-cli";
/** The agent's receiver for a child data-manager issued in the agent's lease store. */
export function verifyControlPeer(
  installation: ControlInstallation,
  input: {
    leaseChild: LeaseChildRef;
    transportPrincipal: ControlTransportPrincipal;
    execution: ExecutionRef;
    kind: string;
  },
): VerifiedControlPeer {
  const state = installationState(installation);
  if (installation.role !== "ops-agent" || input.transportPrincipal !== "data-manager")
    throw Error("Wrong peer transport principal");
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: "data-manager",
    recipient: "ops-agent",
    execution: executionRefSchema.parse(input.execution),
    kind: input.kind,
    leaseChild: leaseChildRefSchema.parse(input.leaseChild),
  });
  return peer;
}
/** A maintenance step the agent issued to itself under the maintenance's lease. */
export function verifyLocalControlPeer(
  installation: ControlInstallation,
  input: { leaseChild: LeaseChildRef; execution: ExecutionRef; kind: string },
): VerifiedControlPeer {
  const state = installationState(installation);
  if (installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Local agent continuation required");
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: "ops-agent",
    local: true,
    recipient: "ops-agent",
    execution: executionRefSchema.parse(input.execution),
    kind: input.kind,
    leaseChild: leaseChildRefSchema.parse(input.leaseChild),
  });
  return peer;
}
/** The agent's fixed CLI child, which the agent recorded before spawning it. */
export function verifyFixedCliControlPeer(
  installation: ControlInstallation,
  input: { leaseChild: LeaseChildRef; execution: ExecutionRef; kind: string },
): VerifiedControlPeer {
  const state = installationState(installation);
  if (installation.role !== "ops-agent" || state.fixedChildId !== input.leaseChild.childKey)
    throw Error("Invalid fixed CLI installation");
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: "ops-agent",
    recipient: "fixed-cli",
    execution: executionRefSchema.parse(input.execution),
    kind: input.kind,
    leaseChild: leaseChildRefSchema.parse(input.leaseChild),
  });
  return peer;
}
const settlements = new WeakMap<object, { state: InstallationState; evidence: ChildSettlement }>();
export function childSettlementState(evidence: VerifiedChildSettlement) {
  const result = settlements.get(evidence);
  if (!result) throw Error("Unverified child settlement");
  return result;
}
const settlementSchema = z.strictObject({
  identity: executionRefSchema,
  outcome: z.enum(["contained", "committed", "failed_without_effect", "unknown"]),
  publication: z.enum(["not_started", "committed", "unknown"]),
  terminalReceiptDigest: digest,
});
const effectObservationSchema = z.discriminatedUnion("kind", [
  localCredentialTemplateReceiptSchema,
  z.strictObject({ kind: z.literal("catalog-pins-initialized"), generationId: digest.nullable() }),
  z.strictObject({
    kind: z.literal("configuration-generation-not-committed"),
    revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
    expectedCurrentRevisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
    result: z.strictObject({
      outcome: z.literal("not_committed"),
      reason: z.enum(["conflict", "busy", "failed"]),
      currentRevisionId: z
        .string()
        .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
        .nullable()
        .optional(),
      cleanupFailed: z.literal(false),
    }),
  }),
  z.strictObject({
    kind: z.literal("data-configuration-fence-refused"),
    maintenanceId: uuid,
    reason: z.literal("busy"),
  }),
  z.strictObject({ kind: z.literal("configuration-fence-not-prepared"), maintenanceId: uuid }),
  z.strictObject({
    kind: z.literal("data-configuration-fence"),
    receipt: dataConfigurationFenceReceiptSchema,
  }),
  z.strictObject({
    kind: z.literal("data-execution"),
    status: dataExecutionStatusSchema,
    workerId: uuid,
    childrenDigest: digest,
  }),
  z.strictObject({ kind: z.literal("data-command"), status: dataExecutionStatusSchema }),
  z.strictObject({ kind: z.literal("ops-result"), result: z.unknown() }),
  z.strictObject({
    kind: z.literal("service-lifecycle-contained-failure"),
    failedReceiptDigest: digest,
  }),
  z.strictObject({ kind: z.literal("feed-proxy-validation-failure"), commitmentDigest: digest }),
  z.strictObject({ kind: z.literal("configuration-helper-completion"), completionDigest: digest }),
  z.strictObject({
    kind: z.literal("fixed-cli-exit"),
    args: z.array(z.string().max(256)).max(64),
    exitCode: z.literal(0),
  }),
  z.strictObject({ kind: z.literal("not-started") }),
  z.strictObject({ kind: z.literal("unresolved") }),
  z.strictObject({ kind: z.literal("reported-failure") }),
]);
/** Leased Docker effects whose command reports its failure: it ran to its end, so its outcome is known. */
const REPORTED_FAILURE_KINDS = new Set([
  "service.stop",
  "service.restart",
  "service.remove",
  "stack.stop",
  "serviceRepository.remove",
  "backup.create",
  "backup.restore",
]);
/** Fixed writer producer only. A DTO, caller error or parsed result cannot
 * substitute for the actual completed native writer observation. */
export function retainConfigurationGenerationNonCommit(
  authority: VerifiedExecutionAuthority,
  observation: OriginalConfigurationGenerationNonCommit,
): void {
  const state = executionAuthorityState(authority),
    actual = originalConfigurationGenerationNonCommitSource(observation),
    admitted = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ) as { operation: unknown },
    operation = opsOperationSchema.parse(admitted.operation);
  if (
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent" ||
    ![
      "stack.render",
      "serviceSelection.apply",
      "serviceConfig.apply",
      "integrationConfig.apply",
      "vault.apply",
    ].includes(state.kind) ||
    !("revisionId" in operation) ||
    !("expectedCurrentRevisionId" in operation) ||
    state.execution.operationKey !== actual.operationKey ||
    operation.revisionId !== actual.revisionId ||
    operation.expectedCurrentRevisionId !== actual.expectedCurrentRevisionId ||
    controlDigest(admitted) !== state.receiptDigest
  )
    throw Error("Original writer/execution noncommit binding required");
  withPrivateEffectWriter(state, () => {
    const receipt = effectObservationSchema.parse({
        kind: "configuration-generation-not-committed",
        revisionId: actual.revisionId,
        expectedCurrentRevisionId: actual.expectedCurrentRevisionId,
        result: actual.result,
      }),
      payload = {
        identity: state.execution,
        outcome: "contained" as const,
        publication: "not_started" as const,
        terminalReceiptDigest: controlDigest(receipt),
        receipt,
      },
      name = `${state.execution.operationKey}.json`;
    const prior = readPrivateRecord(state.installation, "effects", name);
    if (prior !== null) {
      const retained = settlementSchema.extend({ receipt: effectObservationSchema }).parse(prior);
      if (canonicalJson(retained) !== canonicalJson(payload))
        throw Error("Original writer noncommit source changed");
      return;
    }
    settleExecutionLifecycle(state);
    writePrivateRecord(state.installation, "effects", name, payload, false);
  });
}
/** Actual private source, not a caller outcome flag. */
export function inspectConfigurationGenerationNonCommit(
  installation: ControlInstallation,
  execution: ExecutionRef,
) {
  // The original admission must still verify before its effect is read.
  restoreAdmittedControlExecution(installation, execution);
  const local = installationState(installation),
    raw = readPrivateRecord(local, "effects", `${execution.operationKey}.json`),
    effect = settlementSchema.extend({ receipt: effectObservationSchema }).parse(raw);
  if (
    effect.receipt.kind !== "configuration-generation-not-committed" ||
    effect.outcome !== "contained" ||
    effect.publication !== "not_started" ||
    canonicalJson(effect.identity) !== canonicalJson(execution) ||
    effect.terminalReceiptDigest !== controlDigest(effect.receipt)
  )
    throw Error("Actual original generation noncommit required");
  return effect.receipt;
}
export function withPrivateEffectWriter<T>(s: AuthorityState, write: () => T): T {
  const guards = s.installation.privateRoot.directory("effect-writers", true, true);
  try {
    const name = s.execution.operationKey;
    mkdirSync(guards.name(name), { mode: 0o700 });
    fsyncSync(guards.fd);
    const guard = guards.directory(name);
    const held = identity(guard.stat);
    try {
      return write();
    } finally {
      guard.close();
      guards.removeDirectory(name, held);
    }
  } finally {
    guards.close();
  }
}
export function beginControlEffect(authority: VerifiedExecutionAuthority): void {
  const s = executionAuthorityState(authority);
  withControlExecutionForward(authority, () =>
    withPrivateEffectWriter(s, () => {
      try {
        if (
          readPrivateRecord(s.installation, "effects", `${s.execution.operationKey}.json`) !== null
        )
          throw Error("Settled execution cannot restart effects");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const name = `${s.execution.operationKey}.json`;
      if (readPrivateRecord(s.installation, "effect-started", name) !== null)
        throw Error("Execution effects already started");
      writePrivateRecord(
        s.installation,
        "effect-started",
        name,
        { execution: s.execution, receiptDigest: s.receiptDigest },
        false,
      );
    }),
  );
}
function configurationPreEffectState(authority: VerifiedExecutionAuthority) {
  const state = executionAuthorityState(authority),
    raw = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ),
    operation = opsOperationSchema.parse((raw as { operation: unknown }).operation);
  if (
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent" ||
    controlDigest(raw) !== state.receiptDigest ||
    opsOperationFingerprint(operation) !== state.execution.operationFingerprint ||
    !(
      operation.kind === "service.update" ||
      operation.kind === "service.image.stage" ||
      operation.kind === "backup.prune" ||
      operation.kind === "coreService.restart" ||
      operation.kind === "stack.start" ||
      (operation.kind === "service.start" && operation.serviceId !== "data-manager") ||
      (operation.kind === "service.pull" &&
        operation.serviceId === "data-manager" &&
        operation.candidateId)
    )
  )
    throw Error("Fixed managed configuration pre-effect source required");
  return state;
}
/** Existing not-started evidence, only after the original lifecycle is frozen
 * and every exact/reserved child remains unissued and unbound. */
export function retainConfigurationPreEffectRefusal(authority: VerifiedExecutionAuthority): void {
  const state = configurationPreEffectState(authority);
  if (
    cancelControlExecution(authority).length ||
    state.reservations.some((slot) => {
      const retained = inspectControlChildPublication(authority, slot);
      return retained.binding !== null || retained.publication.state !== "unissued";
    })
  )
    throw Error("Issued or bound managed configuration must remain fenced");
  retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
}
/** The transition/restart observer consumes the actual indexed signed effect;
 * an error class or caller status never qualifies nonissuance. */
export function inspectConfigurationPreEffectRefusal(authority: VerifiedExecutionAuthority): void {
  const state = configurationPreEffectState(authority),
    name = `${state.execution.operationKey}.json`,
    raw = readPrivateRecord(state.installation, "effects", name),
    effect = settlementSchema.extend({ receipt: effectObservationSchema }).parse(raw);
  if (
    effect.receipt.kind !== "not-started" ||
    effect.outcome !== "failed_without_effect" ||
    effect.publication !== "not_started" ||
    controlDigest(effect.identity) !== controlDigest(state.execution) ||
    effect.terminalReceiptDigest !== controlDigest(effect.receipt)
  )
    throw Error("Actual unstarted managed configuration receipt required");
  if (
    cancelControlExecution(authority).length ||
    state.reservations.some((slot) => {
      const retained = inspectControlChildPublication(authority, slot);
      return retained.binding !== null || retained.publication.state !== "unissued";
    })
  )
    throw Error("Unstarted managed configuration child source changed");
}
/** Fixed executor adapters supply their parsed result or exact fixed-command exit; arbitrary text is never proof. */
/** Original indexed progress is business evidence only. A success producer must
 * additionally prove its actual children/target tree before committing. */
function readDataWorkflowProgress(authority: VerifiedExecutionAuthority) {
  const s = executionAuthorityState(authority);
  if (s.kind !== "data.update") throw Error("Original Full Update owner required");
  const name = `data-workflow-${s.execution.operationKey}.json`,
    raw = readPrivateRecord(s.installation, "observations", name, 65536);
  const body = z
    .strictObject({
      version: z.literal(1),
      operationKey: z.string(),
      fingerprint: z.string(),
      receipt: dataWorkflowReceiptSchema,
    })
    .parse(raw);
  if (
    body.operationKey !== s.execution.operationKey ||
    body.fingerprint !== s.execution.fingerprint
  )
    throw Error("Full Update checkpoint identity changed");
  return body.receipt;
}
/** The settlement a receipt states. The execution's owner writes it about its
 * own effect, so only the kind's own rules apply: a result that commits, a
 * failure its command reported, and "not started" only before any effect. */
function receiptSettlement(
  s: AuthorityState,
  receipt: z.infer<typeof effectObservationSchema>,
): Pick<ChildSettlement, "outcome" | "publication"> {
  switch (receipt.kind) {
    case "catalog-pins-initialized":
    case "feed-credential-template-written":
    case "configuration-helper-completion":
    case "fixed-cli-exit":
      return { outcome: "committed", publication: "committed" };
    case "data-command":
      return receipt.status.status === "ok"
        ? { outcome: "committed", publication: "committed" }
        : { outcome: "unknown", publication: "unknown" };
    case "service-lifecycle-contained-failure":
      return { outcome: "contained", publication: "committed" };
    case "reported-failure":
      if (!REPORTED_FAILURE_KINDS.has(s.kind) || s.installation.installation.role !== "ops-agent")
        throw Error("Only a leased agent Docker effect reports its own failure");
      return { outcome: "contained", publication: "committed" };
    case "feed-proxy-validation-failure":
      return { outcome: "contained", publication: "not_started" };
    case "configuration-fence-not-prepared":
      return { outcome: "failed_without_effect", publication: "not_started" };
    case "not-started": {
      if (s.installation.fixedChildId) throw Error("Fixed child cannot assert unused execution");
      try {
        if (
          readPrivateRecord(
            s.installation,
            "effect-started",
            `${s.execution.operationKey}.json`,
          ) !== null
        )
          throw Error("Started effects require containment evidence");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      return { outcome: "failed_without_effect", publication: "not_started" };
    }
    case "ops-result": {
      receipt.result = parseBoundedOpsResult(s.kind as OpsOperationKind, receipt.result);
      const result = receipt.result as { outcome?: string };
      // A restored import published nothing.
      if (s.kind === "artifactTransfer.import" && result.outcome === "not_committed")
        return { outcome: "contained", publication: "not_started" };
      if (
        !result.outcome ||
        ["applied", "unchanged", "committed"].includes(result.outcome) ||
        (s.kind === "transitousLock.approve" && result.outcome === "activated") ||
        // These closed results settle their own awaited filesystem leaf. A
        // published install still holds its component lock until API bookkeeping
        // selects the separate commit/restore operation.
        (s.kind === "integration.install" && result.outcome === "published") ||
        (s.kind === "integration.remove" && result.outcome === "removed") ||
        (s.kind === "integration.settle" && result.outcome === "restored") ||
        (s.kind === "catalogIntegration.settle" &&
          ["commit", "rollback"].includes(result.outcome)) ||
        (s.kind === "serviceRepository.settle" &&
          ["commit", "rollback", "release"].includes(result.outcome))
      )
        return { outcome: "committed", publication: "committed" };
      return { outcome: "unknown", publication: "unknown" };
    }
    default:
      return { outcome: "unknown", publication: "unknown" };
  }
}
export function retainControlEffectReceipt(
  authority: VerifiedExecutionAuthority,
  effect: {
    outcome: ChildSettlement["outcome"];
    publication: ChildSettlement["publication"];
    receipt: unknown;
  },
): void {
  const s = executionAuthorityState(authority);
  withPrivateEffectWriter(s, () => {
    const parsed = effectObservationSchema.safeParse(effect.receipt);
    if (!parsed.success) throw Error("Unsupported effect receipt evidence");
    const receipt = parsed.data;
    const { outcome, publication } = receiptSettlement(s, receipt);
    if (effect.outcome !== outcome || effect.publication !== publication)
      throw Error("Effect evidence does not prove requested settlement");
    settleExecutionLifecycle(s);
    const payload = {
      identity: s.execution,
      outcome,
      publication,
      terminalReceiptDigest: controlDigest(receipt),
      receipt,
    };
    const name = `${s.execution.operationKey}.json`;
    try {
      const raw = readPrivateRecord(s.installation, "effects", name);
      if (raw === null) {
        writePrivateRecord(s.installation, "effects", name, payload, false);
        return;
      }
      const prior = settlementSchema.extend({ receipt: effectObservationSchema }).parse(raw);
      if (controlDigest(prior) === controlDigest(payload)) {
        // A completed helper may have lost the write acknowledgement after
        // the signed effect landed but before its terminal record. Repair
        // only this exact source using its original signed completion time.
        return;
      }
      // A later transport/journal failure must never erase proved committed effects.
      if (prior.outcome !== "unknown") return;
      writePrivateRecord(s.installation, "effects", name, payload, false);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      writePrivateRecord(s.installation, "effects", name, payload, true);
    }
  });
}
export function verifyControlEffectSettlement(
  installation: ControlInstallation,
  execution: ExecutionRef,
): VerifiedChildSettlement {
  const s = installationState(installation);
  const evidence = settlementSchema
    .extend({ receipt: effectObservationSchema })
    .parse(readPrivateRecord(s, "effects", `${execution.operationKey}.json`));
  if (evidence.terminalReceiptDigest !== controlDigest(evidence.receipt))
    throw Error("Effect receipt digest mismatch");
  if (controlDigest(evidence.identity) !== controlDigest(execution))
    throw Error("Settlement immutable identity mismatch");
  const verified = Object.freeze({}) as VerifiedChildSettlement;
  const { receipt: _privateReceipt, ...publicEvidence } = evidence;
  settlements.set(verified, { state: s, evidence: publicEvidence });
  return verified;
}
/** Fixed read-only source check for maintenance's pre-root ordinary DM Start.
 * It reads this role's actual original admission, canonical terminal, effect
 * result and released target tree. Candidate metadata alone proves nothing. */
export function verifyMaintenanceCoordinatorPrerequisite(
  installation: ControlInstallation,
  record: PreparedConfigurationRecord,
) {
  const local = installationState(installation),
    fixed = record.coordinatorPrerequisite;
  if (
    installation.role !== "ops-agent" ||
    local.fixedChildId ||
    !record.maintenanceId ||
    !fixed ||
    fixed.operation.kind !== "service.start" ||
    fixed.operation.serviceId !== "data-manager" ||
    fixed.root.operationKey === record.prepareOperationKey ||
    fixed.root.parent.operationKey !== record.parentOperationKey ||
    fixed.root.parent.fingerprint !== record.parentFingerprint ||
    fixed.root.parent.deadlineAt !== record.parentDeadlineAt
  )
    throw Error("Original maintenance coordinator prerequisite required");
  const raw = readPrivateRecord(local, "executions", `${fixed.root.operationKey}.json`, 65536);
  const admitted = z
    .object({
      execution: executionRefSchema,
      kind: z.literal("service.start"),
      operation: opsOperationSchema,
      admittedAt: z.number().int().nonnegative().safe(),
      requestedDeadlineAt: z.number().int().nonnegative().safe(),
      parent: retainedParentExecutionSchema.refine((parent) => parent.issuer === "api"),
    })
    .passthrough()
    .parse(raw);
  if (
    admitted.execution.operationKey !== fixed.root.operationKey ||
    admitted.requestedDeadlineAt !== fixed.root.requestedDeadlineAt ||
    admitted.execution.deadlineAt > admitted.requestedDeadlineAt ||
    admitted.execution.deadlineAt <= admitted.admittedAt ||
    admitted.execution.operationFingerprint !== opsOperationFingerprint(fixed.operation) ||
    admitted.execution.fingerprint !==
      executionFingerprint({
        kind: "service.start",
        operationFingerprint: opsOperationFingerprint(fixed.operation),
        deadlineAt: admitted.execution.deadlineAt,
        parent: admitted.parent,
      }) ||
    canonicalJson(admitted.operation) !== canonicalJson(fixed.operation) ||
    admitted.parent.apiJobId !== record.apiJobId ||
    admitted.parent.operationKey !== record.parentOperationKey ||
    admitted.parent.fingerprint !== record.parentFingerprint ||
    admitted.parent.deadlineAt !== record.parentDeadlineAt
  )
    throw Error("Original coordinator admission changed");
  const authority = restoreAdmittedControlExecution(installation, admitted.execution),
    effect = settlementSchema
      .extend({ receipt: effectObservationSchema })
      .parse(readPrivateRecord(local, "effects", `${fixed.root.operationKey}.json`));
  if (
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    (parseBoundedOpsResult("service.start", effect.receipt.result) as { changed: boolean })
      .changed !== true
  )
    throw Error("Conclusive successful coordinator prerequisite required");
  verifyLocalArtifactTargetRootRelease(authority);
}

declare const stagedCoordinatorBrand: unique symbol;
export type VerifiedStagedCoordinatorOwnership = Readonly<{ [stagedCoordinatorBrand]: true }>;
const stagedCoordinatorProofs = new WeakMap<
  VerifiedStagedCoordinatorOwnership,
  {
    installation: ControlInstallation;
    origin: ControlExecutionOrigin;
    source: z.infer<typeof stagedCoordinatorSourceSchema>;
    status: OpsJobStatus;
  }
>();
export function verifiedStagedCoordinatorOwnershipState(proof: VerifiedStagedCoordinatorOwnership) {
  const value = stagedCoordinatorProofs.get(proof);
  if (!value) throw Error("Actual staged coordinator ownership required");
  return {
    origin: structuredClone(value.origin),
    source: structuredClone(value.source),
  };
}
/** Journal tuples locate source bytes only. This verifies the actual first
 * signed admission, immutable canonical/effect settlement and role-signed API
 * copy without requiring or renewing an expired API candidate or its grants. */
export function readVerifiedStagedCoordinatorOwnership(
  installation: ControlInstallation,
  execution: ExecutionRef,
  input: OpsJobStatus,
): VerifiedStagedCoordinatorOwnership {
  const local = installationState(installation);
  if (installation.role !== "ops-agent" || local.fixedChildId)
    throw Error("Production ops-agent staged source required");
  const raw = readPrivateRecord(local, "executions", `${execution.operationKey}.json`, 65536),
    admitted = z
      .object({
        version: z.literal(2),
        origin: controlOriginSchema,
        kind: z.literal("service.pull"),
        execution: executionRefSchema,
        operation: opsOperationSchema,
        admittedAt: z.number().int().nonnegative().safe(),
        requestedDeadlineAt: z.number().int().nonnegative().safe(),
        parent: retainedParentExecutionSchema,
        coordinatorPullBaseline: coordinatorPullBaselineSchema,
      })
      .passthrough()
      .parse(raw),
    baseline = admitted.coordinatorPullBaseline,
    operation = admitted.operation,
    parent = admitted.parent;
  if (
    canonicalJson(admitted.execution) !== canonicalJson(execution) ||
    execution.executor !== "ops-agent" ||
    execution.principal !== "api" ||
    operation.kind !== "service.pull" ||
    operation.serviceId !== "data-manager" ||
    !operation.candidateId ||
    operation.candidateId !== baseline.candidateId ||
    operation.expectedConfigurationRevisionId !== baseline.configurationRevisionId ||
    execution.operationFingerprint !== opsOperationFingerprint(operation) ||
    parent.issuer !== "api" ||
    execution.deadlineAt > admitted.requestedDeadlineAt ||
    execution.deadlineAt <= admitted.admittedAt ||
    execution.fingerprint !==
      executionFingerprint({
        kind: "service.pull",
        operationFingerprint: execution.operationFingerprint,
        deadlineAt: execution.deadlineAt,
        parent,
      })
  )
    throw Error("Original staged coordinator admission changed");
  const authority = restoreAdmittedControlExecution(installation, execution),
    state = executionAuthorityState(authority),
    terminal = parseOpsJobStatus(input),
    terminalDigest = controlTerminalReceiptDigest(terminal),
    settlement = verifyControlEffectSettlement(installation, execution),
    effectRecord = readPrivateRecord(local, "effects", `${execution.operationKey}.json`),
    effect = settlementSchema.extend({ receipt: effectObservationSchema }).parse(effectRecord);
  if (
    canonicalJson(state.origin) !== canonicalJson(admitted.origin) ||
    terminal.state !== "succeeded" ||
    terminal.operationKey !== execution.operationKey ||
    terminal.fingerprint !== execution.fingerprint ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    canonicalJson(terminal.result) !== canonicalJson(effect.receipt.result)
  )
    throw Error("Actual successful contained staged coordinator source required");
  const result = servicePullResultSchema.parse(effect.receipt.result);
  if (
    result.revisionId !== baseline.configurationRevisionId ||
    result.imageReference !== baseline.configImageReference
  )
    throw Error("Original staged coordinator result changed");
  const source = stagedCoordinatorSourceSchema.parse({
      execution,
      admittedAt: admitted.admittedAt,
      baseline,
      admissionDigest: controlDigest(raw),
      canonicalDigest: terminalDigest,
      effectDigest: controlDigest(childSettlementState(settlement).evidence),
    }),
    proof = Object.freeze({}) as VerifiedStagedCoordinatorOwnership;
  stagedCoordinatorProofs.set(proof, {
    installation,
    origin: state.origin,
    source: structuredClone(source),
    status: structuredClone(input),
  });
  return proof;
}
declare const stagedOwnerBaselineBrand: unique symbol;
export type VerifiedStagedCoordinatorOwnerBaseline = Readonly<{ [stagedOwnerBaselineBrand]: true }>;
const stagedOwnerBaselines = new WeakMap<
  VerifiedStagedCoordinatorOwnerBaseline,
  {
    baseline: CoordinatorPullBaseline;
    expectedCurrentRevisionId: string;
    currentAuthorityRevision: string;
  }
>();
export function verifiedStagedCoordinatorOwnerBaselineState(
  proof: VerifiedStagedCoordinatorOwnerBaseline,
) {
  const value = stagedOwnerBaselines.get(proof);
  if (!value) throw Error("Actual staged original-owner provenance required");
  return structuredClone(value);
}
/** The maintenance file of a `configurationMaintenance.prepare` root, by its admitted body. */
function maintenanceFileOf(state: InstallationState, execution: ExecutionRef): MaintenanceFile {
  const admitted = readPrivateRecord(
    state,
    "executions",
    `${execution.operationKey}.json`,
    65536,
  ) as { operation?: { maintenanceId?: string } };
  const maintenanceId = uuid.parse(admitted.operation?.maintenanceId);
  const file = parseMaintenanceFile(
    readPrivateRecord(state, MAINTENANCE_NAMESPACE, maintenanceFileName(maintenanceId)),
    maintenanceId,
  );
  if (canonicalJson(file.plan.prepare) !== canonicalJson(execution))
    throw Error("Original maintenance root changed");
  return file;
}
/** A separately bound historical observation, never this owner's pull or a
 * caller-selected current generation. All postcommit exceptions verify the
 * original actual canonical/effect/physical child under the same decision. */
export function ownedStagedCoordinatorBaseline(
  authority: VerifiedExecutionAuthority,
): VerifiedStagedCoordinatorOwnerBaseline {
  const state = executionAuthorityState(authority);
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent"
  )
    throw Error("Original staged maintenance owner required");
  const owner = maintenanceFileOf(state.installation, state.execution);
  const observation = stagedCoordinatorObservationPayloadSchema.parse(
      owner.stagedCoordinatorProvenance,
    ),
    baseline = observation.source.baseline;
  if (
    owner.coordinatorPull ||
    owner.plan.coordinatorImage?.action !== "apply" ||
    canonicalJson(observation.ownerPrepare) !== canonicalJson(state.execution) ||
    observation.candidateId !== owner.plan.operation.candidateId ||
    observation.planDigest !== owner.plan.planDigest ||
    baseline.configurationRevisionId !== owner.plan.operation.expectedCurrentRevisionId ||
    canonicalJson(owner.originalContainers.find((c) => c.serviceId === "data-manager")) !==
      canonicalJson(baseline.container)
  )
    throw Error("Original staged owner/source binding changed");
  let expectedCurrentRevisionId = baseline.configurationRevisionId;
  if (owner.record.generation === "committed") {
    if (
      owner.record.steps[0]?.outcome !== "committed" ||
      owner.record.appliedRevisionId !== owner.plan.operation.revisionId
    )
      throw Error("Original staged owner generation required");
    expectedCurrentRevisionId = owner.plan.operation.revisionId;
  } else if (
    owner.record.generation !== "not_started" &&
    owner.record.generation !== "not_committed"
  )
    throw Error("Unknown staged owner generation");
  const proof = Object.freeze({}) as VerifiedStagedCoordinatorOwnerBaseline;
  stagedOwnerBaselines.set(proof, {
    baseline: structuredClone(baseline),
    expectedCurrentRevisionId,
    currentAuthorityRevision: owner.plan.sourceAuthorityRevision,
  });
  return proof;
}
declare const coordinatorBaselineBrand: unique symbol;
export type VerifiedCoordinatorPullBaseline = Readonly<{ [coordinatorBaselineBrand]: true }>;
const baselineProofs = new WeakMap<
  VerifiedCoordinatorPullBaseline,
  Readonly<
    z.infer<typeof coordinatorPullWitnessPayloadSchema> & { expectedCurrentRevisionId: string }
  >
>();
const observedBaselineProofs = new WeakMap<object, VerifiedCoordinatorPullBaseline>();
export function verifiedCoordinatorPullBaselineState(proof: VerifiedCoordinatorPullBaseline) {
  const value = baselineProofs.get(proof);
  if (!value) throw Error("Verified original coordinator baseline required");
  // Return a copy so a consumer cannot mutate the authenticated private observation.
  return structuredClone(value);
}
export function observedCoordinatorPullBaseline(witness: object): VerifiedCoordinatorPullBaseline {
  const proof = observedBaselineProofs.get(witness);
  if (!proof) throw Error("Actual original pull observation required");
  return proof;
}
/** Recovery derives only from the exact indexed signed owner, after the initial
 * successful source copy. It does not depend on a pruned normal pull. */
export function ownedCoordinatorPullBaseline(
  authority: VerifiedExecutionAuthority,
): VerifiedCoordinatorPullBaseline {
  const state = executionAuthorityState(authority);
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent"
  )
    throw Error("Original maintenance owner required");
  const owner = maintenanceFileOf(state.installation, state.execution);
  const witness = coordinatorPullWitnessPayloadSchema.parse(owner.coordinatorPull);
  if (
    canonicalJson(witness.maintenancePrepare) !== canonicalJson(state.execution) ||
    witness.candidateId !== owner.plan.operation.candidateId ||
    witness.maintenanceId !== owner.plan.operation.maintenanceId ||
    witness.baseline.candidateId !== witness.candidateId ||
    witness.baseline.sourceRevision !== witness.sourceRevision ||
    witness.baseline.configurationAuthorityRevision !== owner.plan.sourceAuthorityRevision ||
    witness.baseline.submissionDigest !== witness.submissionDigest ||
    canonicalJson(owner.originalContainers.find((c) => c.serviceId === "data-manager")) !==
      canonicalJson(witness.baseline.container) ||
    owner.plan.coordinatorImage?.imageId !== witness.imageId
  )
    throw Error("Original coordinator owner source changed");
  const proof = Object.freeze({}) as VerifiedCoordinatorPullBaseline;
  baselineProofs.set(
    proof,
    Object.freeze({
      ...structuredClone(witness),
      expectedCurrentRevisionId:
        owner.record.generation === "committed"
          ? owner.plan.operation.revisionId
          : witness.baseline.configurationRevisionId,
    }),
  );
  return proof;
}
/** Fixed source of this one pre-sealed normal pull. Its real signed admission
 * owns the assigned execution ID and effective deadline; neither is predicted. */
export function verifyCoordinatorPullAdmissionSource(
  installation: ControlInstallation,
  record: PreparedConfigurationRecord,
) {
  const state = installationState(installation),
    fixed = record.privateCoordinatorLifecycle;
  if (
    installation.role !== "ops-agent" ||
    state.fixedChildId ||
    fixed?.action !== "update" ||
    record.apiFollowUp !== "coordinator-update" ||
    !record.maintenanceId ||
    fixed.pull.operation.candidateId !== record.candidateId
  )
    throw Error("Original coordinator pull source required");
  const submission = fixed.pull,
    raw = readPrivateRecord(state, "executions", `${submission.operationKey}.json`, 65536),
    admitted = z
      .object({
        version: z.literal(2),
        origin: controlOriginSchema,
        kind: z.literal("service.pull"),
        execution: executionRefSchema,
        operation: opsOperationSchema,
        admittedAt: z.number().int().nonnegative().safe(),
        requestedDeadlineAt: z.number().int().nonnegative().safe(),
        parent: retainedParentExecutionSchema,
        coordinatorPullBaseline: coordinatorPullBaselineSchema,
      })
      .passthrough()
      .parse(raw),
    parent = admitted.parent,
    attempt = submission.attempt,
    execution = admitted.execution;
  if (
    admitted.coordinatorPullBaseline.candidateId !== record.candidateId ||
    admitted.coordinatorPullBaseline.sourceRevision !== record.expectedSourceRevision ||
    admitted.coordinatorPullBaseline.configurationRevisionId !==
      submission.operation.expectedConfigurationRevisionId ||
    admitted.coordinatorPullBaseline.submissionDigest !==
      coordinatorPullSubmissionDigest(submission) ||
    parent.issuer !== "api" ||
    execution.executor !== "ops-agent" ||
    execution.principal !== "api" ||
    execution.operationKey !== submission.operationKey ||
    execution.operationFingerprint !== submission.operationFingerprint ||
    canonicalJson(admitted.operation) !== canonicalJson(submission.operation) ||
    admitted.requestedDeadlineAt !== submission.requestedDeadlineAt ||
    execution.deadlineAt > admitted.requestedDeadlineAt ||
    execution.deadlineAt <= admitted.admittedAt ||
    execution.fingerprint !==
      executionFingerprint({
        kind: "service.pull",
        operationFingerprint: submission.operationFingerprint,
        deadlineAt: execution.deadlineAt,
        parent,
      }) ||
    parent.apiJobId !== record.apiJobId ||
    parent.apiJobId !== attempt.apiJobId ||
    parent.apiOwnerVersion !== attempt.apiOwnerVersion ||
    parent.attemptId !== attempt.attemptId ||
    parent.operationKey !== record.parentOperationKey ||
    parent.operationKey !== attempt.parentOperationKey ||
    parent.fingerprint !== record.parentFingerprint ||
    parent.fingerprint !== attempt.parentFingerprint ||
    parent.deadlineAt !== record.parentDeadlineAt ||
    parent.deadlineAt !== attempt.parentDeadlineAt
  )
    throw Error("Original coordinator normal admission changed");
  restoreAdmittedControlExecution(installation, execution);
  return admitted;
}

/** Only a real immutable canonical terminal + contained effect can mint this
 * copied observation. The structural public status alone supplies no proof. */
export function observeCoordinatorPullForMaintenance(
  installation: ControlInstallation,
  record: PreparedConfigurationRecord,
  maintenancePrepare: ExecutionRef,
  status: OpsJobStatus,
) {
  const admitted = verifyCoordinatorPullAdmissionSource(installation, record),
    authority = restoreAdmittedControlExecution(installation, admitted.execution),
    state = executionAuthorityState(authority),
    terminal = parseOpsJobStatus(status),
    terminalDigest = controlTerminalReceiptDigest(terminal),
    settlement = verifyControlEffectSettlement(installation, admitted.execution),
    effect = settlementSchema
      .extend({ receipt: effectObservationSchema })
      .parse(
        readPrivateRecord(state.installation, "effects", `${admitted.execution.operationKey}.json`),
      );
  if (
    terminal.state !== "succeeded" ||
    terminal.operationKey !== admitted.execution.operationKey ||
    terminal.fingerprint !== admitted.execution.fingerprint ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    canonicalJson(terminal.result) !== canonicalJson(effect.receipt.result)
  )
    throw Error("Actual successful contained coordinator pull required");
  const { changed: _changed, ...result } = servicePullResultSchema.parse(effect.receipt.result),
    fixed = record.privateCoordinatorLifecycle!;
  if (
    fixed.action !== "update" ||
    result.revisionId !== fixed.pull.operation.expectedConfigurationRevisionId
  )
    throw Error("Original coordinator pull revision changed");
  const witness = coordinatorPullWitnessSchema.parse(
    coordinatorPullWitnessPayloadSchema.parse({
      version: 2,
      maintenanceId: record.maintenanceId,
      candidateId: record.candidateId,
      maintenancePrepare,
      pull: admitted.execution,
      submissionDigest: coordinatorPullSubmissionDigest(fixed.pull),
      operationFingerprint: admitted.execution.operationFingerprint,
      apiParentDigest: controlDigest(admitted.parent),
      sourceRevision: record.expectedSourceRevision,
      ...result,
      terminalReceiptDigest: terminalDigest,
      effectReceiptDigest: controlDigest(childSettlementState(settlement).evidence),
      baseline: admitted.coordinatorPullBaseline,
      baselineAdmissionDigest: controlDigest(
        readPrivateRecord(
          state.installation,
          "executions",
          `${admitted.execution.operationKey}.json`,
          65536,
        ),
      ),
      verifiedAt: Date.now(),
    }),
  );
  const proof = Object.freeze({}) as VerifiedCoordinatorPullBaseline;
  baselineProofs.set(
    proof,
    Object.freeze({
      ...structuredClone(witness),
      expectedCurrentRevisionId: admitted.coordinatorPullBaseline.configurationRevisionId,
    }),
  );
  observedBaselineProofs.set(witness, proof);
  return witness;
}
const recovery = new WeakMap<object, { authority: AuthorityState; evidence: ChildSettlement }>();
export function verifyControlRecoveryAuthority(
  authority: VerifiedExecutionAuthority,
): VerifiedRecoveryAuthority {
  const s = executionAuthorityState(authority);
  const evidence = childSettlementState(
    verifyControlEffectSettlement(s.installation.installation, s.execution),
  ).evidence;
  const result = Object.freeze({}) as VerifiedRecoveryAuthority;
  recovery.set(result, { authority: s, evidence });
  return result;
}
export function recoveryAuthorityState(value: VerifiedRecoveryAuthority) {
  const s = recovery.get(value);
  if (!s) throw Error("Unverified recovery authority");
  return s;
}

/** Exact role parent identity is independent of the assertion that binds its child (no hash cycle). */
export function retainedControlParent(execution: ExecutionRef): RetainedParentExecution {
  const retained = executionRefSchema.parse(execution);
  return {
    issuer: retained.executor,
    execution: retained,
    operationKey: retained.operationKey,
    fingerprint: retained.fingerprint,
    deadlineAt: retained.deadlineAt,
  };
}

function executionWitnessDirectory(state: InstallationState, issuer: ControlIssuer) {
  // Execution witnesses stay in the role's own private state. Another role
  // learns about an execution from the request that names it, never from here.
  const executions = state.privateRoot.directory("execution-witnesses", true, true),
    role = executions.directory(issuer, true, true);
  return {
    role,
    close() {
      role.close();
      executions.close();
    },
  };
}
const lifecycleSchema = z.strictObject({
  version: z.literal(1),
  execution: executionRefSchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: z.enum(["held", "cancel_pending", "recovery_required", "settled"]),
});
type ExecutionLifecycle = z.infer<typeof lifecycleSchema>;
function withExecutionWriter<T>(
  state: InstallationState,
  execution: ExecutionRef,
  run: (dir: AnchoredDirectory) => T,
): T {
  const d = executionWitnessDirectory(state, execution.executor);
  const name = `${execution.operationKey}.writer`;
  let guard: AnchoredDirectory | undefined;
  try {
    mkdirSync(d.role.name(name), { mode: 0o700 });
    fsyncSync(d.role.fd);
    guard = d.role.directory(name);
    return run(d.role);
  } finally {
    if (guard) {
      const held = identity(guard.stat);
      guard.close();
      d.role.removeDirectory(name, held);
    }
    d.close();
  }
}
function readLifecycle(dir: AnchoredDirectory, execution: ExecutionRef): ExecutionLifecycle {
  const current = lifecycleSchema.parse(
    JSON.parse(dir.read(`${execution.operationKey}.lifecycle.json`, 65536).toString("utf8")),
  );
  if (controlDigest(current.execution) !== controlDigest(execution))
    throw Error("Execution lifecycle identity mismatch");
  return current;
}
function writeLifecycle(dir: AnchoredDirectory, lifecycle: ExecutionLifecycle, exclusive = false) {
  const bytes = canonicalJson(lifecycle);
  if (Buffer.byteLength(bytes) > 65536) throw Error("Execution lifecycle capacity");
  dir.write(`${lifecycle.execution.operationKey}.lifecycle.json`, bytes, exclusive);
}
function initializeLifecycle(
  state: InstallationState,
  execution: ExecutionRef,
  newlyAdmitted: boolean,
) {
  withExecutionWriter(state, execution, (dir) => {
    try {
      readLifecycle(dir, execution);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (!newlyAdmitted)
        throw Error("Missing retained execution lifecycle requires supervised recovery");
      writeLifecycle(
        dir,
        {
          version: 1,
          execution,
          sequence: 0,
          phase: "held",
        },
        true,
      );
    }
  });
}
/** Whether a fixed child's parent, which holds no lease, still permits forward effects. */
function fixedParentForward(state: InstallationState): boolean {
  const parent = state.fixedParent;
  if (!parent) return true;
  return withExecutionWriter(state, parent, (dir) => {
    const lifecycle = readLifecycle(dir, parent);
    return lifecycle.phase === "held" && Date.now() < parent.deadlineAt;
  });
}
/** Narrow local runtime fence; exact duplicate admission alone never grants forward permission. */
export class ControlExecutionFencedError extends Error {}
export function withControlExecutionForward<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = executionAuthorityState(authority);
  const check = () =>
    withExecutionWriter(s.installation, s.execution, (dir) => {
      const lifecycle = readLifecycle(dir, s.execution);
      if (lifecycle.phase !== "held" || Date.now() >= s.execution.deadlineAt)
        throw new ControlExecutionFencedError(
          "Execution cannot restart effects; observation/settlement only; forward phase fenced",
        );
      return run();
    });
  if (!fixedParentForward(s.installation))
    throw new ControlExecutionFencedError("Canceled/terminal ancestor permits observation only");
  return check();
}
/** Internal publication scope. All filesystem writes complete before guards
 * release; callers may not await HTTP/DB or acquire a lease from this scope. */
const publicationScopes = new WeakMap<VerifiedExecutionAuthority, AnchoredDirectory>();
export function assertControlPublicationScope(
  authority: VerifiedExecutionAuthority,
): AnchoredDirectory {
  const directory = publicationScopes.get(authority);
  if (!directory) throw Error("Control publication scope is not held");
  return directory;
}
export function withControlDelegationPublication<T>(
  authority: VerifiedExecutionAuthority,
  phase: ControlChildPhase,
  run: (directory: AnchoredDirectory) => T,
): T {
  const s = executionAuthorityState(authority);
  const own = () =>
    withExecutionWriter(s.installation, s.execution, (directory) => {
      const current = readLifecycle(directory, s.execution);
      if (s.kind === "configurationMaintenance.prepare") {
        const owner = maintenanceFileOf(s.installation, s.execution);
        if (canonicalJson(owner.plan.reservations) !== canonicalJson(s.reservations))
          throw Error("Original maintenance issuer changed");
        if (
          [
            "configuration-commit",
            "maintenance-hardlinks",
            "maintenance-recreate",
            "maintenance-handoff",
          ].includes(phase) &&
          (owner.record.state !== "applying" ||
            owner.record.cancelRequestedAt !== null ||
            owner.record.fence?.state !== "prepared")
        )
          throw new ControlExecutionFencedError(
            "Original applying configuration maintenance required",
          );
      }
      const prepared =
        (s.kind === "configurationMaintenance.prepare" &&
          [
            "configuration-commit",
            "maintenance-hardlinks",
            "maintenance-recreate",
            "maintenance-handoff",
          ].includes(phase)) ||
        (s.kind === "configurationHandoff.prepare" && phase === "configuration-handoff");
      if (
        Date.now() >= s.execution.deadlineAt ||
        !(current.phase === "held" || (current.phase === "settled" && prepared))
      )
        throw new ControlExecutionFencedError(
          "Control grant publication is fenced; terminal or canceled execution prevents forward effects",
        );
      if (current.phase === "settled") verifyControlPreparedTerminal(s.installation, s.execution);
      if (publicationScopes.has(authority)) throw Error("Nested control publication scope");
      publicationScopes.set(authority, directory);
      try {
        return run(directory);
      } finally {
        publicationScopes.delete(authority);
      }
    });
  if (!fixedParentForward(s.installation))
    throw Error("Canceled ancestor prevents grant publication");
  return own();
}
export function assertControlExecutionForward(authority: VerifiedExecutionAuthority): void {
  withControlExecutionForward(authority, () => {});
}
/** Only the protocol's frozen terminal preparation edges may outlive their local worker. */
export function assertControlDelegationForward(
  authority: VerifiedExecutionAuthority,
  phase: ControlChildPhase,
): void {
  withControlDelegationPublication(authority, phase, () => {});
}
/** Persist before a runtime publishes canceled state; return original attempted child identities for cancellation/lookup. */
export function cancelControlExecution(
  authority: VerifiedExecutionAuthority,
): readonly ExecutionRef[] {
  const s = executionAuthorityState(authority);
  return withExecutionWriter(s.installation, s.execution, (dir) => {
    const lifecycle = readLifecycle(dir, s.execution);
    if (lifecycle.phase !== "settled" && lifecycle.phase !== "cancel_pending") {
      lifecycle.phase = "cancel_pending";
      lifecycle.sequence++;
      writeLifecycle(dir, lifecycle);
    }
    // Every child is a reserved phase, recorded as attempted before it is issued.
    const children: ExecutionRef[] = [];
    for (const reserved of s.reservations) {
      const saved = inspectControlChildPublication(authority, reserved);
      if (saved.publication.state === "grant_prepared" && saved.binding)
        children.push(Object.freeze({ ...saved.binding.child.execution }));
    }
    const distinct = new Map<string, ExecutionRef>();
    for (const child of children) {
      const prior = distinct.get(child.operationKey);
      if (prior && controlDigest(prior) !== controlDigest(child))
        throw Error("Cancellation child identity disagreement");
      distinct.set(child.operationKey, child);
    }
    return Object.freeze([...distinct.values()]);
  });
}
export function settleExecutionLifecycle(s: AuthorityState) {
  withExecutionWriter(s.installation, s.execution, (dir) => {
    const lifecycle = readLifecycle(dir, s.execution);
    if (lifecycle.phase !== "settled") {
      lifecycle.phase = "settled";
      lifecycle.sequence++;
      writeLifecycle(dir, lifecycle);
    }
  });
}
/**
 * Issues a child that runs only under this execution's deadline: the fixed
 * CLI's data workflow, or a data-manager data phase. The parent holds no
 * lease; the reserved phase records the child before it is sent.
 */
export async function attestParentExecution(
  authority: VerifiedExecutionAuthority,
  child: {
    execution: ExecutionRef;
    phase: ControlChildPhase;
    serviceIds: readonly string[];
    recipient: ControlRecipient;
    childKey?: string;
  },
): Promise<ControlDelegation> {
  const s = executionAuthorityState(authority);
  if (Date.now() >= s.execution.deadlineAt) throw Error("Expired parent execution");
  const plan = resolveControlChildPlan(authority, child);
  if (!plan || !childPhaseKinds[child.phase].includes(plan.kind))
    throw Error("Child absent from retained plan");
  if (await s.installation.leases.read(rootLeaseId(s.execution)))
    throw Error("Deadline-only parent must not hold targets");
  if (
    child.recipient === "fixed-cli"
      ? child.phase !== "data-workflow" || s.installation.installation.role !== "ops-agent"
      : child.recipient !== "data-manager" ||
        !["osm", "transit", "fonts", "data-step"].includes(child.phase)
  )
    throw Error("Unauthorized deadline-only edge");
  if (["osm", "transit", "fonts"].includes(child.phase) && s.kind !== "data.update")
    throw Error("Only Full Update may delegate data phases");
  verifyDeadlineEdge(s.kind, child.phase, child.recipient, plan.kind);
  const childKey =
    child.recipient === "fixed-cli"
      ? fixedChildSpawn(s.installation, uuid.parse(child.childKey), child.execution).childKey
      : randomUUID();
  const delegation = dataControlDelegationSchema.parse({
    leaseId: null,
    childKey,
    owner: s.execution,
    parent: s.execution,
    execution: child.execution,
    kind: plan.kind,
    phase: child.phase,
    targets: [],
    origin: s.origin,
  });
  return withControlDelegationPublication(authority, child.phase, (dir) => {
    const lifecycle = readLifecycle(dir, s.execution);
    if (lifecycle.phase !== "held" || Date.now() >= s.execution.deadlineAt)
      throw Error("Canceled/terminal execution cannot authorize forward children");
    prepareControlChildPublication(authority, plan, delegation);
    return delegation;
  });
}
export function verifyDeadlineEdge(
  parentKind: string,
  phase: ControlChildPhase,
  recipient: ControlRecipient,
  childKind: string,
) {
  const dataKinds: Record<string, string> = {
    "data.downloadOsm": "download-osm",
    "data.downloadFonts": "download-fonts",
    "data.convertOverpass": "convert-overpass",
    "data.overtureSync": "overture-sync",
    "data.overturePull": "overture-pull",
    "data.overtureIngest": "overture-ingest",
    "data.overtureExtract": "overture-extract",
    "data.overtureConflate": "overture-conflate",
    "data.searchIndexBuild": "search-index-build",
    "data.notablePlacesBuild": "notable-places-build",
  };
  if (
    recipient === "fixed-cli" &&
    phase === "data-workflow" &&
    childKind === parentKind &&
    childPhaseKinds[phase].includes(parentKind)
  )
    return;
  if (
    recipient === "data-manager" &&
    ((["osm", "transit", "fonts"].includes(phase) && parentKind === "data.update") ||
      (phase === "data-step" && dataKinds[parentKind] === childKind))
  )
    return;
  throw Error("Unauthorized deadline-only child kind");
}
/** A fixed child shares the agent's private records and is known by its spawn record. */
export function openFixedChildInstallation(options: {
  infraDir: string;
  child: { leaseId: string | null; childKey: string };
}): ControlInstallation {
  const childKey = uuid.parse(options.child.childKey);
  let recovery: AnchoredDirectory | undefined;
  try {
    recovery = new AnchoredDirectory(
      controlPrivateRoot(options.infraDir, "ops-agent"),
      undefined,
      true,
    );
    const installation = Object.freeze({ role: "ops-agent" }) as ControlInstallation;
    const state: InstallationState = {
      installation,
      privateRoot: recovery,
      dataRoot: join(options.infraDir, "data"),
      registeredTargets: new Set(),
      // Fixed children run in the agent's container or its helper: both use the store.
      leases: agentStoreLeases(options.infraDir, "ops-agent"),
      fixedChildId: childKey,
    };
    const spawn = fixedChildSpawn(state, childKey);
    // A child of a parent that holds no lease follows its parent's lifecycle.
    if (options.child.leaseId === null) state.fixedParent = spawn.parent;
    registerControlInstallation(state);
    recovery = undefined;
    return installation;
  } finally {
    recovery?.close();
  }
}
const spawnIntentSchema = z.strictObject({
  parent: executionRefSchema,
  plan: z.array(plannedChildSchema).max(64),
  reservations: z.array(controlChildReservationSchema).max(64).optional(),
  execution: executionRefSchema,
  operation: opsOperationSchema,
  dataUpdatePlan: dataUpdatePlanSchema.optional(),
  dataWorkflowInitial: dataWorkflowReceiptSchema.optional(),
  args: z.array(z.string().max(4096)).max(64),
  serviceIds: targetSchema,
  admittedAt: z.number().int().nonnegative().safe(),
});
/** The spawn record of a fixed CLI child, written by its parent before the child is issued. */
export function fixedChildSpawn(
  state: InstallationState,
  childKey: string,
  execution?: ExecutionRef,
): z.infer<typeof spawnIntentSchema> & { childKey: string } {
  const saved = spawnIntentSchema.parse(
    readPrivateRecord(state, "spawns", `${uuid.parse(childKey)}.json`, 65536),
  );
  if (execution && controlDigest(saved.execution) !== controlDigest(execution))
    throw Error("Fixed child spawn identity mismatch");
  return { ...saved, childKey };
}
export function retainFixedCliSpawnIntent(
  authority: VerifiedExecutionAuthority,
  input: {
    childKey: string;
    execution: ExecutionRef;
    operation: unknown;
    args: readonly string[];
    plan?: readonly ControlPlannedChild[];
    reservations?: readonly ControlChildReservation[];
    dataUpdatePlan?: import("./data-update-records").DataUpdatePlan;
    dataWorkflowInitial?: import("../ops/job-evidence").DataWorkflowReceipt;
  },
): void {
  const s = executionAuthorityState(authority);
  if (s.installation.installation.role !== "ops-agent" || s.installation.fixedChildId)
    throw Error("Only the agent spawns fixed children");
  const id = uuid.parse(input.childKey);
  const operation = opsOperationSchema.parse(input.operation);
  const slot = [...s.plan, ...s.reservations].find(
    (p) => p.execution.executionId === input.execution.executionId && p.recipient === "fixed-cli",
  );
  const plan = slot
    ? resolveControlChildPlan(authority, {
        phase: slot.phase,
        execution: input.execution,
        recipient: "fixed-cli",
      })
    : undefined;
  if (
    !plan ||
    opsOperationFingerprint(operation) !== input.execution.operationFingerprint ||
    operation.kind !== plan.kind ||
    canonicalJson(fixedCliArguments(operation)) !== canonicalJson(input.args)
  )
    throw Error("Fixed command does not match retained child plan");
  writePrivateRecord(
    s.installation,
    "spawns",
    `${id}.json`,
    spawnIntentSchema.parse({
      parent: s.execution,
      execution: input.execution,
      operation,
      ...(input.dataUpdatePlan ? { dataUpdatePlan: input.dataUpdatePlan } : {}),
      ...(input.dataWorkflowInitial ? { dataWorkflowInitial: input.dataWorkflowInitial } : {}),
      args: input.args,
      serviceIds: plan.serviceIds,
      admittedAt: Date.now(),
      plan: input.plan ?? [],
      ...(input.reservations === undefined ? {} : { reservations: input.reservations }),
    }),
    true,
  );
}
export function fixedCliArguments(operation: import("../ops/contract").OpsOperation): string[] {
  switch (operation.kind) {
    case "service.build":
      return [
        "services",
        "build",
        operation.serviceId,
        ...(operation.regionId ? ["--region", operation.regionId] : []),
      ];
    case "services.buildAll":
      return [
        "services",
        "build-all",
        ...(operation.regionId ? ["--region", operation.regionId] : []),
      ];
    case "service.start":
      return [
        "services",
        "start",
        operation.serviceId,
        "--expected-configuration-revision",
        operation.expectedConfigurationRevisionId,
      ];
    case "service.update":
      return [
        "services",
        "update",
        operation.serviceId,
        "--expected-configuration-revision",
        operation.expectedConfigurationRevisionId,
        ...(operation.noDeps ? ["--no-deps"] : []),
      ];
    case "data.link":
      return ["data", "link"];
    case "data.clean":
      return ["data", "clean", operation.dataTypeId];
    case "data.update":
      return [
        "data",
        "update",
        ...(operation.regionId ? [operation.regionId] : []),
        ...(operation.countryCodes?.length
          ? ["--countries", operation.countryCodes.join(",")]
          : []),
        ...(operation.failFast ? ["--fail-fast"] : []),
      ];
    case "data.overtureConflate":
      return [
        "data",
        "overture-conflate",
        operation.regionId,
        ...(operation.restart ? ["--restart"] : []),
      ];
    case "data.downloadOsm":
      return ["data", "download", "osm", ...(operation.regionId ? [operation.regionId] : [])];
    case "data.downloadFonts":
      return ["data", "download", "fonts"];
    case "data.convertOverpass":
      return ["data", "convert", "overpass", ...(operation.regionId ? [operation.regionId] : [])];
    case "data.overtureSync":
      return ["data", "overture-sync", operation.regionId];
    case "data.overturePull":
      return ["data", "overture-pull", operation.regionId];
    case "data.overtureIngest":
      return ["data", "overture-ingest", operation.regionId];
    case "data.overtureExtract":
      return ["data", "overture-extract", operation.regionId];
    case "data.searchIndexBuild":
      return ["data", "search-index", "build", operation.regionId];
    case "data.notablePlacesBuild":
      return ["data", "notable-places", "build"];
    default:
      throw Error("This fixed CLI control consumer is unavailable");
  }
}
export function readFixedCliSpawnIntent(
  installation: ControlInstallation,
  execution: ExecutionRef,
  args: readonly string[],
) {
  const s = installationState(installation);
  if (!s.fixedChildId) throw Error("Fixed child authority required");
  const saved = fixedChildSpawn(s, s.fixedChildId);
  if (
    controlDigest(execution) !== controlDigest(saved.execution) ||
    canonicalJson(args) !== canonicalJson(saved.args) ||
    canonicalJson(fixedCliArguments(saved.operation)) !== canonicalJson(saved.args) ||
    opsOperationFingerprint(saved.operation) !== execution.operationFingerprint
  )
    throw Error("Fixed CLI spawn identity/command mismatch");
  s.registeredTargets = new Set(saved.serviceIds);
  return saved;
}
export function beginFixedCliExecution(
  installation: ControlInstallation,
  execution: ExecutionRef,
): void {
  const s = installationState(installation);
  if (!s.fixedChildId) throw Error("Fixed CLI authority required");
  if (!fixedParentForward(s)) throw Error("Canceled/terminal parent prevents fixed CLI start");
  writePrivateRecord(s, "spawn-started", `${s.fixedChildId}.json`, { execution }, true);
}

/** Restore only the original signed durable admission; this grants no permission to redispatch. */
export function restoreAdmittedControlExecution(
  installation: ControlInstallation,
  execution: ExecutionRef,
): VerifiedExecutionAuthority {
  const state = installationState(installation);
  const raw = readPrivateRecord(state, "executions", `${execution.operationKey}.json`, 65536);
  const payload = z
    .object({
      version: z.literal(2),
      execution: executionRefSchema,
      kind: z.string(),
      serviceIds: targetSchema,
      origin: controlOriginSchema,
      plan: z.array(plannedChildSchema).max(64),
      reservations: z.array(controlChildReservationSchema).max(64).optional(),
    })
    .passthrough()
    .parse(raw);
  if (controlDigest(payload.execution) !== controlDigest(execution))
    throw Error("Recovery execution ownership mismatch");
  const authority = Object.freeze({ execution: payload.execution }) as VerifiedExecutionAuthority;
  authorities.set(authority, {
    installation: state,
    execution: payload.execution,
    kind: payload.kind,
    serviceIds: payload.serviceIds,
    plan: payload.plan,
    reservations: payload.reservations ?? [],
    receiptDigest: controlDigest(raw),
    origin: payload.origin,
  });
  return authority;
}
/** Fixed local continuation adapter: private signed admission, never a bare request identity. */
export function verifiedRetainedControlParent(
  installation: ControlInstallation,
  execution: ExecutionRef,
): import("../ops/execution-identity").VerifiedParentExecution {
  const authority = restoreAdmittedControlExecution(installation, execution);
  const s = executionAuthorityState(authority);
  const parent = Object.freeze(
    retainedControlParent(execution),
  ) as import("../ops/execution-identity").VerifiedParentExecution;
  verifiedParents.add(parent);
  verifiedParentOrigins.set(parent, s.origin);
  return parent;
}
/** Whether the agent journal records this maintenance or handoff preparation
 * as succeeded with a prepared result; the journal is its only terminal record. */
export function verifyControlPreparedTerminal(
  state: InstallationState,
  execution: ExecutionRef,
): void {
  const infra = new AnchoredDirectory(dirname(state.dataRoot));
  let stateDir: AnchoredDirectory | undefined;
  let jobs: AnchoredDirectory | undefined;
  try {
    stateDir = infra.directory("state");
    jobs = stateDir.directory("ops-agent");
    const journal = z
      .object({ version: z.literal(2), jobs: z.array(z.unknown()).max(512) })
      .parse(JSON.parse(jobs.read("jobs-v1.json", 24 * 1024 * 1024).toString("utf8")));
    const matches = journal.jobs.filter(
      (j) =>
        j &&
        typeof j === "object" &&
        (j as { operationId?: string }).operationId === execution.executionId,
    );
    if (matches.length !== 1) throw Error("Missing exact terminal preparation journal");
    const job = z
      .object({
        operationKey: z.string(),
        fingerprint: digest,
        state: z.literal("succeeded"),
        operation: z.object({
          kind: z.literal("configurationMaintenance.prepare"),
        }),
        result: z
          .object({
            phase: z.literal("prepared").optional(),
            state: z.literal("prepared").optional(),
          })
          .passthrough(),
      })
      .parse(matches[0]);
    if (
      job.operationKey !== execution.operationKey ||
      job.fingerprint !== execution.fingerprint ||
      !(job.result.phase === "prepared" || job.result.state === "prepared")
    )
      throw Error("Terminal preparation identity mismatch");
  } finally {
    jobs?.close();
    stateDir?.close();
    infra.close();
  }
}

/** Target acquisition observes only its original data-phase owner and all three
 * signed, physically settled DM children. No progress object is authority. */
export async function verifyDataUpdatePrerequisites(
  authority: VerifiedExecutionAuthority,
  transport: DataManagerTransport | undefined,
  signal?: AbortSignal,
) {
  const s = executionAuthorityState(authority);
  if (s.kind !== "data.update" || s.installation.fixedChildId)
    throw Error("Original Full Update root required");
  const name = `data-update-plan-${s.execution.operationKey}.json`,
    raw = readPrivateRecord(s.installation, "observations", name, 128 * 1024);
  const plan = dataUpdatePlanSchema.parse(raw),
    infraDir = dirname(s.installation.dataRoot);
  if (
    controlDigest(plan.parent) !== controlDigest(s.execution) ||
    opsOperationFingerprint(plan.operation) !== s.execution.operationFingerprint ||
    currentConfigurationGeneration(infraDir) !== plan.revisionId ||
    dataUpdateSourcesDigest(infraDir) !== plan.sourcesDigest
  )
    throw Error("Original Full Update sources changed");
  let childInstallation: ControlInstallation | undefined;
  try {
    let dataAuthority = authority;
    if (s.execution.executor === "ops-agent") {
      const attempt = lookupControlChildPhaseAttempt(authority, {
        phase: "data-workflow",
        ordinal: 0,
      });
      if (!attempt) throw Error("Full Update data phase not admitted");
      childInstallation = openFixedChildInstallation({
        infraDir,
        child: { leaseId: attempt.leaseId, childKey: attempt.childKey },
      });
      dataAuthority = restoreAdmittedControlExecution(childInstallation, attempt.execution);
      const settlement = childSettlementState(
        verifyControlEffectSettlement(childInstallation, attempt.execution),
      ).evidence;
      if (settlement.outcome !== "committed" || settlement.publication !== "committed")
        throw Error("Full Update data phase unsettled");
    }
    const receipt = readDataWorkflowProgress(dataAuthority);
    if (
      receipt.phase !== "build" ||
      receipt.children.length !== 3 ||
      receipt.children.some((c) => c.status !== "succeeded")
    )
      throw Error("Full Update data checkpoint missing");
    if (!transport) throw Error("Full Update prerequisites are read from data-manager");
    for (const [index, slot] of plan.dataChildren.entries()) {
      const bound = lookupControlChildPhase(dataAuthority, slot);
      if (!bound) throw Error("Full Update prerequisite missing");
      const child = receipt.children[index],
        terminal = await readDataManagerTerminal(bound.execution, transport, signal);
      if (
        !child ||
        child.operationKey !== bound.execution.operationKey ||
        child.jobId !== bound.execution.executionId ||
        child.fingerprint !== bound.execution.fingerprint ||
        child.deadlineAt !== bound.execution.deadlineAt ||
        terminal.status !== "ok" ||
        terminal.publication !== "committed"
      )
        throw Error("Full Update prerequisite did not complete");
    }
    return receipt;
  } finally {
    if (childInstallation) closeControlInstallation(childInstallation);
  }
}

export function validateControlChildReservations(input: {
  role: ControlRecipient | "host-cli";
  kind: string;
  execution: ExecutionRef;
  serviceIds: readonly string[];
  plan: readonly ControlPlannedChild[];
  reservations: readonly ControlChildReservation[];
}): void {
  const slots = [...input.plan, ...input.reservations].sort((a, b) => a.ordinal - b.ordinal);
  if (
    slots.length > 64 ||
    new Set(slots.map((slot) => slot.execution.operationKey)).size !== slots.length
  )
    throw Error("Control child reservation capacity or duplicate key");
  for (const [ordinal, slot] of slots.entries()) {
    if (
      slot.ordinal !== ordinal ||
      slot.execution.operationKey !==
        controlChildOperationKey(input.execution.operationKey, slot.phase, ordinal) ||
      !childPhaseKinds[slot.phase]?.includes(slot.kind) ||
      slot.serviceIds.some((id) => !input.serviceIds.includes(id))
    )
      throw Error("Invalid immutable child reservation");
    if (
      (slot.recipient === "fixed-cli" && slot.phase === "data-workflow") ||
      (slot.recipient === "data-manager" &&
        ["osm", "transit", "fonts", "data-step"].includes(slot.phase))
    )
      verifyDeadlineEdge(input.kind, slot.phase, slot.recipient, slot.kind);
    else verifyFiniteControlEdge(input.role, input.kind, slot.phase, slot.recipient);
    const executor =
      slot.recipient === "ops-agent"
        ? "ops-agent"
        : slot.recipient === "data-manager"
          ? "data-manager"
          : "host-cli";
    if (slot.execution.executor !== executor)
      throw Error("Reserved receiver execution address mismatch");
  }
}
const planSchema = z.lazy(() =>
  z.strictObject({
    phase: z.enum(Object.keys(childPhaseKinds) as [ControlChildPhase, ...ControlChildPhase[]]),
    ordinal: z.number().int().min(0).max(63),
    kind: z.string(),
    recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
    serviceIds: z.array(z.string()).max(256),
    execution: executionRefSchema,
  }),
);
const publicationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unissued") }),
  z.strictObject({
    state: z.literal("grant_prepared"),
    delegation: dataControlDelegationSchema,
  }),
]);
const cellSchema = z.strictObject({
  version: z.literal(2),
  origin: controlOriginSchema,
  parent: executionRefSchema,
  admissionDigest: digest,
  reservationDigest: digest,
  binding: z
    .strictObject({
      child: planSchema,
      boundAt: z.number().int().nonnegative().safe(),
      requestedDeadlineAt: z.number().int().nonnegative().safe(),
    })
    .nullable(),
  publication: publicationSchema,
});
type Cell = z.infer<typeof cellSchema>;
const cellName = (authority: VerifiedExecutionAuthority, ordinal: number) =>
  `phase-${authority.execution.operationKey}-${ordinal}.json`;
function reservation(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const state = executionAuthorityState(authority);
  const value = state.reservations.find(
    (r) => r.phase === input.phase && r.ordinal === input.ordinal,
  );
  if (!value) throw Error("Phase is absent from immutable reservations");
  return { state, value };
}
function readCell(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
): Cell {
  const { state, value } = reservation(authority, input);
  const raw = readPrivateRecord(
    state.installation,
    "observations",
    cellName(authority, input.ordinal),
    8192,
  );
  const cell = cellSchema.parse(raw);
  if (
    controlDigest(cell.origin) !== controlDigest(state.origin) ||
    controlDigest(cell.parent) !== controlDigest(state.execution) ||
    cell.admissionDigest !== state.receiptDigest ||
    cell.reservationDigest !== controlDigest(value)
  )
    throw Error("Reserved phase binding identity changed");
  if (cell.binding) {
    const { child, boundAt, requestedDeadlineAt } = cell.binding;
    const expected = {
      phase: value.phase,
      ordinal: value.ordinal,
      kind: value.kind,
      recipient: value.recipient,
      serviceIds: value.serviceIds,
      execution: {
        ...value.execution,
        operationFingerprint: value.operationFingerprint,
        deadlineAt: requestedDeadlineAt,
        fingerprint: executionFingerprint({
          kind: value.kind,
          operationFingerprint: value.operationFingerprint,
          deadlineAt: requestedDeadlineAt,
          parent: retainedControlParent(state.execution),
        }),
      },
    };
    if (
      requestedDeadlineAt <= boundAt ||
      requestedDeadlineAt > state.execution.deadlineAt ||
      controlDigest(child) !== controlDigest(expected)
    )
      throw Error("Reserved phase exact identity mismatch");
  } else if (cell.publication.state !== "unissued")
    throw Error("An unbound phase cannot have a grant");
  return cell;
}
function writeCell(
  authority: VerifiedExecutionAuthority,
  ordinal: number,
  cell: Cell,
  exclusive = false,
) {
  const state = executionAuthorityState(authority);
  const record = cellSchema.parse(cell);
  if (Buffer.byteLength(canonicalJson(record)) > 8192)
    throw Error("Phase binding capacity exceeded");
  writePrivateRecord(
    state.installation,
    "observations",
    cellName(authority, ordinal),
    record,
    exclusive,
  );
}
/** Called by durable admission before any forward witness/effect becomes ready. */
export function initializeControlChildReservations(authority: VerifiedExecutionAuthority): void {
  const state = executionAuthorityState(authority);
  const cells = state.reservations.map((r) => ({
    r,
    cell: cellSchema.parse({
      version: 2,
      origin: state.origin,
      parent: state.execution,
      admissionDigest: state.receiptDigest,
      reservationDigest: controlDigest(r),
      binding: null,
      publication: { state: "unissued" },
    }),
  }));
  // Bound exact identities, decimal epoch lengths and UUID/digest publication
  // fields have fixed maxima. Budget their complete records up front.
  const maximum = cells.reduce((total, { r, cell }) => {
    const largestExecution = {
      executor: "ops-agent",
      principal: "data-manager",
      executionId: "f".repeat(68),
      operationKey: "f".repeat(69),
      operationFingerprint: "f".repeat(64),
      fingerprint: "f".repeat(64),
      deadlineAt: Number.MAX_SAFE_INTEGER,
    };
    const largest = {
      ...cell,
      binding: {
        boundAt: Number.MAX_SAFE_INTEGER,
        requestedDeadlineAt: Number.MAX_SAFE_INTEGER,
        child: {
          phase: r.phase,
          ordinal: r.ordinal,
          kind: r.kind,
          recipient: r.recipient,
          serviceIds: r.serviceIds,
          execution: {
            ...r.execution,
            operationFingerprint: r.operationFingerprint,
            deadlineAt: Number.MAX_SAFE_INTEGER,
            fingerprint: "f".repeat(64),
          },
        },
      },
      publication: {
        state: "grant_prepared",
        delegation: {
          leaseId: "f".repeat(36),
          childKey: "f".repeat(36),
          owner: largestExecution,
          parent: largestExecution,
          execution: largestExecution,
          kind: r.kind,
          phase: r.phase,
          targets: r.serviceIds,
          origin: state.origin,
        },
      },
    };
    const size = Buffer.byteLength(canonicalJson(largest));
    if (size > 8192) throw Error("Phase binding cell capacity exceeded");
    return total + size;
  }, 0);
  if (maximum > 128 * 1024) throw Error("Phase binding aggregate capacity exceeded");
  for (const { r, cell } of cells) writeCell(authority, r.ordinal, cell, true);
}
export function lookupControlChildPhase(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
): ControlPlannedChild | null {
  return readCell(authority, input).binding?.child ?? null;
}
export async function bindControlChildPhase(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
): Promise<ControlPlannedChild> {
  const retained = readCell(authority, input);
  if (retained.binding) return retained.binding.child;
  return withControlDelegationPublication(authority, input.phase, () => {
    const current = readCell(authority, input);
    if (current.binding) return current.binding.child;
    const { state, value } = reservation(authority, input),
      boundAt = Date.now();
    const requestedDeadlineAt = Math.min(
      state.execution.deadlineAt,
      boundAt + opsExecutionBudget(value.kind).processMs,
    );
    const normalized = normalizeExecutionAdmission({
      kind: value.kind,
      operationKey: value.execution.operationKey,
      operationFingerprint: value.operationFingerprint,
      admittedAt: boundAt,
      requestedDeadlineAt,
      parent: verifiedRetainedControlParent(state.installation.installation, state.execution),
    });
    const child = {
      phase: value.phase,
      ordinal: value.ordinal,
      kind: value.kind,
      recipient: value.recipient,
      serviceIds: [...value.serviceIds],
      execution: {
        ...value.execution,
        operationFingerprint: value.operationFingerprint,
        deadlineAt: normalized.deadlineAt,
        fingerprint: normalized.fingerprint,
      },
    };
    writeCell(authority, value.ordinal, {
      ...current,
      binding: { child, boundAt, requestedDeadlineAt },
    });
    return child;
  });
}
/** Internal fixed issuer hook, invoked while the actual publication guards are held. */
export function prepareControlChildPublication(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
  delegation: ControlDelegation,
): void {
  assertControlPublicationScope(authority);
  const state = executionAuthorityState(authority);
  if (!state.reservations.some((r) => r.phase === input.phase && r.ordinal === input.ordinal))
    return;
  const cell = readCell(authority, input);
  if (!cell.binding || cell.publication.state !== "unissued")
    throw Error("Reserved phase publication requires observation");
  writeCell(authority, input.ordinal, {
    ...cell,
    publication: { state: "grant_prepared", delegation },
  });
}
export function inspectControlChildPublication(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = readCell(authority, input);
  return {
    binding: cell.binding,
    publication: cell.publication,
    bindingDigest: controlDigest(cell.binding),
  };
}
export function lookupControlChildPhaseBinding(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = readCell(authority, input);
  return cell.binding
    ? Object.freeze({ ...cell.binding, bindingDigest: controlDigest(cell.binding) })
    : null;
}
/** The child an attempted phase issued, for observation and cancellation only.
 * This returns no ticket and never repairs or reissues a missing attempt. */
export function lookupControlChildPhaseAttempt(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = readCell(authority, input),
    s = executionAuthorityState(authority);
  if (cell.publication.state === "unissued") return null;
  if (!cell.binding) throw Error("Attempted phase has no exact binding");
  const delegation = cell.publication.delegation;
  if (
    delegation.kind !== cell.binding.child.kind ||
    controlDigest(delegation.execution) !== controlDigest(cell.binding.child.execution) ||
    controlDigest(delegation.parent) !== controlDigest(s.execution)
  )
    throw Error("Original phase child identity changed");
  return Object.freeze({
    channel: delegation.leaseId === null ? ("parent" as const) : ("delegation" as const),
    delegation,
    leaseId: delegation.leaseId,
    childKey: delegation.childKey,
    execution: cell.binding.child.execution,
    bindingDigest: controlDigest(cell.binding),
  });
}
export function resolveControlChildPlan(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; execution: ExecutionRef; recipient: ControlRecipient },
): ControlPlannedChild | undefined {
  const state = executionAuthorityState(authority);
  const exact = state.plan.find(
    (p) =>
      p.phase === input.phase &&
      p.recipient === input.recipient &&
      controlDigest(p.execution) === controlDigest(input.execution),
  );
  if (exact) return exact;
  const slot = state.reservations.find(
    (r) => r.phase === input.phase && r.execution.operationKey === input.execution.operationKey,
  );
  if (!slot) return undefined;
  const bound = lookupControlChildPhase(authority, slot);
  if (
    bound &&
    bound.recipient === input.recipient &&
    controlDigest(bound.execution) === controlDigest(input.execution)
  )
    return bound;
  return undefined;
}

/**
 * Checks that the execution's own root is released: its own effect settled
 * with a known outcome and its lease is gone from the store.
 */
export function verifyLocalArtifactTargetRootRelease(authority: VerifiedExecutionAuthority): void {
  if (!localRootReleased(authority)) throw Error("Original root release is not proved");
}
export function localRootReleased(authority: VerifiedExecutionAuthority): boolean {
  const a = executionAuthorityState(authority);
  childSettlementState(verifyControlEffectSettlement(a.installation.installation, a.execution));
  return !requireLocalLeases(a.installation.leases).readSync(rootLeaseId(a.execution));
}
