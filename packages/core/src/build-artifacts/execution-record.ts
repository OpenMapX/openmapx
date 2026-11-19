/** One execution as its role recorded it: the admitted operation, its
 * lifecycle, its effect start and settlement, and the children it reserved.
 * The record is one row in the role's store (`ExecutionRows`). */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PreparedConfigurationRecord } from "../ops/configuration-preparation";
import { type OpsOperationKind, opsOperationSchema, parseBoundedOpsResult } from "../ops/contract";
import { type ControlExecutionOrigin, parseControlRootOperationKey } from "../ops/control-root-key";
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
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
import {
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
import {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  digest,
  type InstallationState,
  targetSchema,
  uuid,
} from "./control-records";
import { dataUpdatePlanSchema } from "./data-update-records";
import {
  type ChildCell,
  type ControlPlannedChild,
  type ExecutionAdmission,
  type ExecutionProgress,
  type ExecutionRow,
  type ExecutionSettlement,
  plannedChildSchema,
} from "./execution-rows";
import { AnchoredDirectory } from "./filesystem";
import {
  type ControlChildPhase,
  type ControlChildReservation,
  type ControlRecipient,
  childPhaseKinds,
  controlChildOperationKey,
  controlChildReservationSchema,
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
  controlPrivateRoot,
  installationState,
  readPrivateRecord,
  registerControlInstallation,
  roleExecutionRows,
  writePrivateRecord,
} from "./private-records";

export type { ControlExecutionOrigin } from "../ops/control-root-key";
export type { ControlPlannedChild } from "./execution-rows";

/** An admitted execution: its row's admission, and the store it lives in. */
export type ExecutionHandle = Readonly<
  ExecutionAdmission & {
    installation: InstallationState;
    /** Digest of the admission; module records name the execution by it. */
    receiptDigest: string;
  }
>;
declare const peerBrand: unique symbol;
export type VerifiedControlPeer = Readonly<{ [peerBrand]: true }>;
export type ChildSettlement = Omit<ExecutionSettlement, "receipt">;

function missingRow(): Error {
  return Object.assign(Error("Missing execution row"), { code: "ENOENT" });
}
function handleOf(state: InstallationState, admission: ExecutionAdmission): ExecutionHandle {
  return Object.freeze({
    ...admission,
    installation: state,
    receiptDigest: controlDigest(admission),
  });
}
/** The handle's current row; a row whose admission changed is refused. */
function rowOf(handle: ExecutionHandle): ExecutionRow {
  handle.installation.privateRoot.check();
  const row = handle.installation.rows.read(handle.execution.operationKey);
  if (!row) throw missingRow();
  if (controlDigest(row.admission) !== handle.receiptDigest)
    throw Error("Durable execution authority changed");
  return row;
}
function progressOf(handle: ExecutionHandle): ExecutionProgress {
  return rowOf(handle).progress;
}
/** Applies `change` to the handle's progress and saves it before resolving. */
function updateProgress<T>(
  handle: ExecutionHandle,
  change: (progress: ExecutionProgress) => T,
): Promise<T> {
  rowOf(handle);
  return handle.installation.rows.update(handle.execution.operationKey, change);
}

/** The origin an execution recorded at admission. */
export function retainedExecutionOrigin(
  state: InstallationState,
  execution: ExecutionRef,
): ControlExecutionOrigin {
  const row = state.rows.read(execution.operationKey);
  if (!row) throw missingRow();
  if (controlDigest(execution) !== controlDigest(row.admission.execution))
    throw Error("Execution origin identity mismatch");
  return row.admission.origin;
}
/** Fixed adapters call after their own durable admission, passing the complete typed operation, never only its IDs. */
export async function retainAdmittedControlExecution(
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
  },
): Promise<ExecutionHandle> {
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
    if (
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
  const requested: Omit<ExecutionAdmission, "origin"> = {
    execution,
    kind: input.kind,
    operation: input.operation,
    admittedAt: input.admittedAt,
    ...(input.requestedDeadlineAt === undefined
      ? {}
      : { requestedDeadlineAt: input.requestedDeadlineAt }),
    ...(input.parent ? { parent: input.parent } : {}),
    ...(input.leaseChild ? { leaseChild: input.leaseChild } : {}),
    serviceIds,
    plan,
    reservations,
  };
  const existing = state.rows.read(execution.operationKey);
  if (existing) {
    const { origin: _origin, ...retained } = existing.admission;
    if (canonicalJson(retained) !== canonicalJson(requested))
      throw Error("Conflicting retained execution identity");
    return handleOf(state, existing.admission);
  }
  let origin: ControlExecutionOrigin;
  const inherited = input.parent && verifiedParentOrigins.get(input.parent);
  if (inherited) {
    if (!input.parent || !verifiedParents.has(input.parent))
      throw Error("Unverified parent origin");
    origin = controlOriginSchema.parse(inherited);
  } else {
    if (input.parent && (input.parent.issuer !== "api" || !verifiedParents.has(input.parent)))
      throw Error("A child needs its parent's verified origin; this parent can only be observed");
    const parsedKey = parseControlRootOperationKey(execution.operationKey);
    const now = Date.now();
    if (parsedKey.notAfter <= now) throw Error("Expired control root expiry");
    if (
      parsedKey.notAfter - now > 7 * 24 * 3600_000 ||
      input.requestedDeadlineAt !== parsedKey.notAfter
    )
      throw Error("Control root requested deadline must equal its expiry within seven days");
    origin = {
      version: 1,
      rootKey: execution.operationKey,
      issuer: execution.executor,
      notAfter: parsedKey.notAfter,
    };
  }
  if (execution.deadlineAt > origin.notAfter)
    throw Error("Control execution widens origin deadline");
  const admission: ExecutionAdmission = { ...requested, origin };
  assertControlStorageAvailable(installation);
  await state.rows.admit({
    admission,
    progress: {
      phase: "held",
      effectStartedAt: null,
      settlement: null,
      settledAt: null,
      children: reservations.map((r) => ({ ordinal: r.ordinal, binding: null, delegation: null })),
    },
  });
  return handleOf(state, admission);
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
export type EffectReceipt = z.infer<typeof effectObservationSchema>;
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
/** The settlement recorded on a row, with its receipt checked against its kind's schema. */
function settlementOf(row: ExecutionRow) {
  const settlement = row.progress.settlement;
  if (!settlement) return null;
  const receipt = effectObservationSchema.parse(settlement.receipt);
  if (
    settlement.terminalReceiptDigest !== controlDigest(receipt) ||
    controlDigest(settlement.identity) !== controlDigest(row.admission.execution)
  )
    throw Error("Effect receipt digest mismatch");
  return { ...settlement, receipt };
}
/** Records the owner's terminal settlement on its row; a settled row keeps a known outcome. */
function recordSettlement(
  progress: ExecutionProgress,
  payload: ExecutionSettlement,
  options: { replaceUnknown: boolean },
): void {
  const prior = progress.settlement;
  progress.phase = "settled";
  if (prior) {
    if (canonicalJson(prior) === canonicalJson(payload)) return;
    // A later transport or journal failure must never erase a proved outcome.
    if (!options.replaceUnknown || prior.outcome !== "unknown") return;
  }
  progress.settlement = payload;
  progress.settledAt = Date.now();
}
/** Records the owner's terminal settlement as given; the module producing it proved it. */
export function settleExecution(
  handle: ExecutionHandle,
  settlement: {
    outcome: ChildSettlement["outcome"];
    publication: ChildSettlement["publication"];
    receipt: EffectReceipt;
  },
): Promise<void> {
  const receipt = effectObservationSchema.parse(settlement.receipt);
  const payload: ExecutionSettlement = {
    identity: handle.execution,
    outcome: settlement.outcome,
    publication: settlement.publication,
    terminalReceiptDigest: controlDigest(receipt),
    receipt,
  };
  return updateProgress(handle, (progress) =>
    recordSettlement(progress, payload, { replaceUnknown: true }),
  );
}
/** Fixed writer producer only. A DTO, caller error or parsed result cannot
 * substitute for the actual completed native writer observation. */
export async function retainConfigurationGenerationNonCommit(
  handle: ExecutionHandle,
  observation: OriginalConfigurationGenerationNonCommit,
): Promise<void> {
  const actual = originalConfigurationGenerationNonCommitSource(observation),
    operation = opsOperationSchema.parse(handle.operation);
  if (
    handle.installation.fixedChildId ||
    handle.installation.installation.role !== "ops-agent" ||
    ![
      "stack.render",
      "serviceSelection.apply",
      "serviceConfig.apply",
      "integrationConfig.apply",
      "vault.apply",
    ].includes(handle.kind) ||
    !("revisionId" in operation) ||
    !("expectedCurrentRevisionId" in operation) ||
    handle.execution.operationKey !== actual.operationKey ||
    operation.revisionId !== actual.revisionId ||
    operation.expectedCurrentRevisionId !== actual.expectedCurrentRevisionId
  )
    throw Error("Original writer/execution noncommit binding required");
  const receipt = effectObservationSchema.parse({
    kind: "configuration-generation-not-committed",
    revisionId: actual.revisionId,
    expectedCurrentRevisionId: actual.expectedCurrentRevisionId,
    result: actual.result,
  });
  const payload: ExecutionSettlement = {
    identity: handle.execution,
    outcome: "contained",
    publication: "not_started",
    terminalReceiptDigest: controlDigest(receipt),
    receipt,
  };
  await updateProgress(handle, (progress) => {
    if (progress.settlement && canonicalJson(progress.settlement) !== canonicalJson(payload))
      throw Error("Original writer noncommit source changed");
    recordSettlement(progress, payload, { replaceUnknown: false });
  });
}
/** Actual private source, not a caller outcome flag. */
export function inspectConfigurationGenerationNonCommit(
  installation: ControlInstallation,
  execution: ExecutionRef,
) {
  const handle = restoreAdmittedControlExecution(installation, execution),
    effect = settlementOf(rowOf(handle));
  if (
    !effect ||
    effect.receipt.kind !== "configuration-generation-not-committed" ||
    effect.outcome !== "contained" ||
    effect.publication !== "not_started"
  )
    throw Error("Actual original generation noncommit required");
  return effect.receipt;
}
/** The receipt the execution's own settlement recorded. */
export function executionReceipt(handle: ExecutionHandle): EffectReceipt {
  const settlement = settlementOf(rowOf(handle));
  if (!settlement) throw Error("Execution is not settled");
  return settlement.receipt;
}
/** Whether the execution recorded its own settlement. */
export function executionSettled(handle: ExecutionHandle): boolean {
  return progressOf(handle).settlement !== null;
}
/** Whether the execution recorded the start of its effects. */
export function executionEffectStarted(handle: ExecutionHandle): boolean {
  return progressOf(handle).effectStartedAt !== null;
}
/** Records the start of effects, before the first one; never twice, never after cancellation. */
export async function beginControlEffect(handle: ExecutionHandle): Promise<void> {
  assertControlExecutionForward(handle);
  await updateProgress(handle, (progress) => {
    if (progress.settlement) throw Error("Settled execution cannot restart effects");
    if (progress.effectStartedAt !== null) throw Error("Execution effects already started");
    assertForward(handle, progress);
    progress.effectStartedAt = Date.now();
  });
}
function assertConfigurationPreEffectSource(handle: ExecutionHandle) {
  const operation = opsOperationSchema.parse(handle.operation);
  if (
    handle.installation.fixedChildId ||
    handle.installation.installation.role !== "ops-agent" ||
    opsOperationFingerprint(operation) !== handle.execution.operationFingerprint ||
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
}
/** Whether any reserved child was bound or sent. */
function anyChildAttempted(progress: ExecutionProgress): boolean {
  return progress.children.some((cell) => cell.binding !== null || cell.delegation !== null);
}
/** Existing not-started evidence, only after the original lifecycle is frozen
 * and every reserved child remains unissued and unbound. */
export async function retainConfigurationPreEffectRefusal(handle: ExecutionHandle): Promise<void> {
  assertConfigurationPreEffectSource(handle);
  if ((await cancelControlExecution(handle)).length || anyChildAttempted(progressOf(handle)))
    throw Error("Issued or bound managed configuration must remain fenced");
  await retainControlEffectReceipt(handle, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
}
/** The transition/restart observer consumes the actual recorded effect;
 * an error class or caller status never qualifies nonissuance. */
export function inspectConfigurationPreEffectRefusal(handle: ExecutionHandle): void {
  assertConfigurationPreEffectSource(handle);
  const row = rowOf(handle),
    effect = settlementOf(row);
  if (
    !effect ||
    effect.receipt.kind !== "not-started" ||
    effect.outcome !== "failed_without_effect" ||
    effect.publication !== "not_started"
  )
    throw Error("Actual unstarted managed configuration receipt required");
  if (attemptedChildren(row.progress).length || anyChildAttempted(row.progress))
    throw Error("Unstarted managed configuration child source changed");
}
/** The settlement a receipt states. The execution's owner writes it about its
 * own effect, so only the kind's own rules apply: a result that commits, a
 * failure its command reported, and "not started" only before any effect. */
function receiptSettlement(
  handle: ExecutionHandle,
  progress: ExecutionProgress,
  receipt: EffectReceipt,
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
      if (
        !REPORTED_FAILURE_KINDS.has(handle.kind) ||
        handle.installation.installation.role !== "ops-agent"
      )
        throw Error("Only a leased agent Docker effect reports its own failure");
      return { outcome: "contained", publication: "committed" };
    case "feed-proxy-validation-failure":
      return { outcome: "contained", publication: "not_started" };
    case "configuration-fence-not-prepared":
      return { outcome: "failed_without_effect", publication: "not_started" };
    case "not-started":
      if (handle.installation.fixedChildId)
        throw Error("Fixed child cannot assert unused execution");
      if (progress.effectStartedAt !== null)
        throw Error("Started effects require containment evidence");
      return { outcome: "failed_without_effect", publication: "not_started" };
    case "ops-result": {
      receipt.result = parseBoundedOpsResult(handle.kind as OpsOperationKind, receipt.result);
      const result = receipt.result as { outcome?: string };
      // A restored import published nothing.
      if (handle.kind === "artifactTransfer.import" && result.outcome === "not_committed")
        return { outcome: "contained", publication: "not_started" };
      if (
        !result.outcome ||
        ["applied", "unchanged", "committed"].includes(result.outcome) ||
        (handle.kind === "transitousLock.approve" && result.outcome === "activated") ||
        // These closed results settle their own awaited filesystem leaf. A
        // published install still holds its component lock until API bookkeeping
        // selects the separate commit/restore operation.
        (handle.kind === "integration.install" && result.outcome === "published") ||
        (handle.kind === "integration.remove" && result.outcome === "removed") ||
        (handle.kind === "integration.settle" && result.outcome === "restored") ||
        (handle.kind === "catalogIntegration.settle" &&
          ["commit", "rollback"].includes(result.outcome)) ||
        (handle.kind === "serviceRepository.settle" &&
          ["commit", "rollback", "release"].includes(result.outcome))
      )
        return { outcome: "committed", publication: "committed" };
      return { outcome: "unknown", publication: "unknown" };
    }
    default:
      return { outcome: "unknown", publication: "unknown" };
  }
}
/** Records the owner's settlement after checking that its receipt proves it. */
export async function retainControlEffectReceipt(
  handle: ExecutionHandle,
  effect: {
    outcome: ChildSettlement["outcome"];
    publication: ChildSettlement["publication"];
    receipt: unknown;
  },
): Promise<void> {
  const parsed = effectObservationSchema.safeParse(effect.receipt);
  if (!parsed.success) throw Error("Unsupported effect receipt evidence");
  const receipt = parsed.data;
  await updateProgress(handle, (progress) => {
    const { outcome, publication } = receiptSettlement(handle, progress, receipt);
    if (effect.outcome !== outcome || effect.publication !== publication)
      throw Error("Effect evidence does not prove requested settlement");
    recordSettlement(
      progress,
      {
        identity: handle.execution,
        outcome,
        publication,
        terminalReceiptDigest: controlDigest(receipt),
        receipt,
      },
      { replaceUnknown: true },
    );
  });
}
/** The settlement an execution recorded about its own effect. */
export function verifyControlEffectSettlement(
  installation: ControlInstallation,
  execution: ExecutionRef,
): ChildSettlement {
  const row = installationState(installation).rows.read(execution.operationKey);
  if (!row) throw missingRow();
  if (controlDigest(row.admission.execution) !== controlDigest(execution))
    throw Error("Settlement immutable identity mismatch");
  const settlement = settlementOf(row);
  if (!settlement) throw Error("Execution is not settled");
  const { receipt: _receipt, ...known } = settlement;
  return known;
}
/** Fixed read-only source check for maintenance's pre-root ordinary DM Start.
 * It reads this role's actual original admission, terminal, effect result and
 * released target tree. Candidate metadata alone proves nothing. */
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
  const row = local.rows.read(fixed.root.operationKey);
  if (!row) throw missingRow();
  const admitted = row.admission,
    parent = retainedParentExecutionSchema
      .refine((value) => value.issuer === "api")
      .parse(admitted.parent);
  if (
    admitted.kind !== "service.start" ||
    admitted.requestedDeadlineAt === undefined ||
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
        parent,
      }) ||
    canonicalJson(opsOperationSchema.parse(admitted.operation)) !==
      canonicalJson(fixed.operation) ||
    parent.apiJobId !== record.apiJobId ||
    parent.operationKey !== record.parentOperationKey ||
    parent.fingerprint !== record.parentFingerprint ||
    parent.deadlineAt !== record.parentDeadlineAt
  )
    throw Error("Original coordinator admission changed");
  const handle = handleOf(local, admitted),
    effect = settlementOf(row);
  if (
    !effect ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    (parseBoundedOpsResult("service.start", effect.receipt.result) as { changed: boolean })
      .changed !== true
  )
    throw Error("Conclusive successful coordinator prerequisite required");
  verifyLocalArtifactTargetRootRelease(handle);
}

/** The maintenance file of a `configurationMaintenance.prepare` root, by its admitted body. */
function maintenanceFileOf(handle: ExecutionHandle): MaintenanceFile {
  const maintenanceId = uuid.parse(
    (handle.operation as { maintenanceId?: string } | undefined)?.maintenanceId,
  );
  const file = parseMaintenanceFile(
    readPrivateRecord(
      handle.installation,
      MAINTENANCE_NAMESPACE,
      maintenanceFileName(maintenanceId),
    ),
    maintenanceId,
  );
  if (canonicalJson(file.plan.prepare) !== canonicalJson(handle.execution))
    throw Error("Original maintenance root changed");
  return file;
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

/** Whether a fixed child's parent, which holds no lease, still permits forward effects. */
function fixedParentForward(state: InstallationState): boolean {
  const parent = state.fixedParent;
  if (!parent) return true;
  const row = state.rows.read(parent.operationKey);
  if (!row || controlDigest(row.admission.execution) !== controlDigest(parent)) return false;
  return row.progress.phase === "held" && Date.now() < parent.deadlineAt;
}
/** Narrow local runtime fence; exact duplicate admission alone never grants forward permission. */
export class ControlExecutionFencedError extends Error {}
function assertForward(handle: ExecutionHandle, progress: ExecutionProgress): void {
  if (progress.phase !== "held" || Date.now() >= handle.execution.deadlineAt)
    throw new ControlExecutionFencedError(
      "Execution cannot restart effects; observation/settlement only; forward phase fenced",
    );
  if (!fixedParentForward(handle.installation))
    throw new ControlExecutionFencedError("Canceled/terminal ancestor permits observation only");
}
export function withControlExecutionForward<T>(handle: ExecutionHandle, run: () => T): T {
  assertForward(handle, progressOf(handle));
  return run();
}
export function assertControlExecutionForward(handle: ExecutionHandle): void {
  assertForward(handle, progressOf(handle));
}
const PREPARED_MAINTENANCE_PHASES: readonly string[] = [
  "configuration-commit",
  "maintenance-hardlinks",
  "maintenance-recreate",
  "maintenance-handoff",
];
/** Whether `phase` may still issue: only the protocol's prepared edges outlive the worker. */
function assertDelegationForward(
  handle: ExecutionHandle,
  phase: ControlChildPhase,
  progress: ExecutionProgress,
): void {
  if (handle.kind === "configurationMaintenance.prepare") {
    const owner = maintenanceFileOf(handle);
    if (canonicalJson(owner.plan.reservations) !== canonicalJson(handle.reservations))
      throw Error("Original maintenance issuer changed");
    if (
      PREPARED_MAINTENANCE_PHASES.includes(phase) &&
      (owner.record.state !== "applying" ||
        owner.record.cancelRequestedAt !== null ||
        owner.record.fence?.state !== "prepared")
    )
      throw new ControlExecutionFencedError("Original applying configuration maintenance required");
  }
  const prepared =
    (handle.kind === "configurationMaintenance.prepare" &&
      PREPARED_MAINTENANCE_PHASES.includes(phase)) ||
    (handle.kind === "configurationHandoff.prepare" && phase === "configuration-handoff");
  if (
    Date.now() >= handle.execution.deadlineAt ||
    !(progress.phase === "held" || (progress.phase === "settled" && prepared))
  )
    throw new ControlExecutionFencedError(
      "Control grant publication is fenced; terminal or canceled execution prevents forward effects",
    );
  if (progress.phase === "settled")
    verifyControlPreparedTerminal(handle.installation, handle.execution);
  if (!fixedParentForward(handle.installation))
    throw Error("Canceled ancestor prevents grant publication");
}
/**
 * Runs `run` on the row's progress while it may still issue `phase`, and saves
 * what it recorded before resolving: a child is attempted once this resolves.
 */
export function withControlDelegationPublication<T>(
  handle: ExecutionHandle,
  phase: ControlChildPhase,
  run: (progress: ExecutionProgress) => T,
): Promise<T> {
  assertDelegationForward(handle, phase, progressOf(handle));
  return updateProgress(handle, (progress) => {
    assertDelegationForward(handle, phase, progress);
    return run(progress);
  });
}
/** Only the protocol's frozen terminal preparation edges may outlive their local worker. */
export function assertControlDelegationForward(
  handle: ExecutionHandle,
  phase: ControlChildPhase,
): void {
  assertDelegationForward(handle, phase, progressOf(handle));
}
function attemptedChildren(progress: ExecutionProgress): ExecutionRef[] {
  const distinct = new Map<string, ExecutionRef>();
  for (const cell of progress.children) {
    if (!cell.delegation || !cell.binding) continue;
    const child = Object.freeze({ ...cell.binding.child.execution });
    const prior = distinct.get(child.operationKey);
    if (prior && controlDigest(prior) !== controlDigest(child))
      throw Error("Cancellation child identity disagreement");
    distinct.set(child.operationKey, child);
  }
  return [...distinct.values()];
}
/** Persist before a runtime publishes canceled state; return the attempted children for cancellation. */
export async function cancelControlExecution(
  handle: ExecutionHandle,
): Promise<readonly ExecutionRef[]> {
  return updateProgress(handle, (progress) => {
    if (progress.phase === "held") progress.phase = "cancel_pending";
    // Every child is a reserved phase, recorded as attempted before it is issued.
    return Object.freeze(attemptedChildren(progress));
  });
}
/**
 * Issues a child that runs only under this execution's deadline: the fixed
 * CLI's data workflow, or a data-manager data phase. The parent holds no
 * lease; the reserved phase records the child before it is sent.
 */
export async function attestParentExecution(
  handle: ExecutionHandle,
  child: {
    execution: ExecutionRef;
    phase: ControlChildPhase;
    serviceIds: readonly string[];
    recipient: ControlRecipient;
    childKey?: string;
  },
): Promise<ControlDelegation> {
  if (Date.now() >= handle.execution.deadlineAt) throw Error("Expired parent execution");
  const plan = resolveControlChildPlan(handle, child);
  if (!plan || !childPhaseKinds[child.phase].includes(plan.kind))
    throw Error("Child absent from retained plan");
  if (await handle.installation.leases.read(rootLeaseId(handle.execution)))
    throw Error("Deadline-only parent must not hold targets");
  if (
    child.recipient === "fixed-cli"
      ? child.phase !== "data-workflow" || handle.installation.installation.role !== "ops-agent"
      : child.recipient !== "data-manager" ||
        !["osm", "transit", "fonts", "data-step"].includes(child.phase)
  )
    throw Error("Unauthorized deadline-only edge");
  if (["osm", "transit", "fonts"].includes(child.phase) && handle.kind !== "data.update")
    throw Error("Only Full Update may delegate data phases");
  verifyDeadlineEdge(handle.kind, child.phase, child.recipient, plan.kind);
  const childKey =
    child.recipient === "fixed-cli"
      ? fixedChildSpawn(handle.installation, uuid.parse(child.childKey), child.execution).childKey
      : randomUUID();
  const delegation = dataControlDelegationSchema.parse({
    leaseId: null,
    childKey,
    owner: handle.execution,
    parent: handle.execution,
    execution: child.execution,
    kind: plan.kind,
    phase: child.phase,
    targets: [],
    origin: handle.origin,
  });
  return withControlDelegationPublication(handle, child.phase, (progress) => {
    if (progress.phase !== "held")
      throw Error("Canceled/terminal execution cannot authorize forward children");
    prepareControlChildPublication(handle, progress, plan, delegation);
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
      // Its own row is a file; its parent's, when the agent journals it, is there.
      rows: roleExecutionRows("ops-agent", options.infraDir, recovery),
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
  handle: ExecutionHandle,
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
  if (handle.installation.installation.role !== "ops-agent" || handle.installation.fixedChildId)
    throw Error("Only the agent spawns fixed children");
  const id = uuid.parse(input.childKey);
  const operation = opsOperationSchema.parse(input.operation);
  const slot = [...handle.plan, ...handle.reservations].find(
    (p) => p.execution.executionId === input.execution.executionId && p.recipient === "fixed-cli",
  );
  const plan = slot
    ? resolveControlChildPlan(handle, {
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
    handle.installation,
    "spawns",
    `${id}.json`,
    spawnIntentSchema.parse({
      parent: handle.execution,
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

/** The original admission only; this grants no permission to dispatch again. */
export function restoreAdmittedControlExecution(
  installation: ControlInstallation,
  execution: ExecutionRef,
): ExecutionHandle {
  const state = installationState(installation);
  const row = state.rows.read(execution.operationKey);
  if (!row) throw missingRow();
  if (controlDigest(row.admission.execution) !== controlDigest(execution))
    throw Error("Recovery execution ownership mismatch");
  return handleOf(state, row.admission);
}
/** Fixed local continuation adapter: private retained admission, never a bare request identity. */
export function verifiedRetainedControlParent(
  installation: ControlInstallation,
  execution: ExecutionRef,
): import("../ops/execution-identity").VerifiedParentExecution {
  const handle = restoreAdmittedControlExecution(installation, execution);
  const parent = Object.freeze(
    retainedControlParent(execution),
  ) as import("../ops/execution-identity").VerifiedParentExecution;
  verifiedParents.add(parent);
  verifiedParentOrigins.set(parent, handle.origin);
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
function reservation(
  handle: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const value = handle.reservations.find(
    (r) => r.phase === input.phase && r.ordinal === input.ordinal,
  );
  if (!value) throw Error("Phase is absent from immutable reservations");
  return value;
}
/** The reserved child's cell, checked against its reservation. */
function cellOf(
  handle: ExecutionHandle,
  progress: ExecutionProgress,
  input: { phase: ControlChildPhase; ordinal: number },
): ChildCell {
  const value = reservation(handle, input);
  const cell = progress.children.find((entry) => entry.ordinal === input.ordinal);
  if (!cell) throw Error("Reserved phase binding identity changed");
  if (cell.binding) {
    const { child, boundAt, requestedDeadlineAt } = cell.binding;
    const expected = {
      phase: value.phase,
      ordinal: value.ordinal,
      kind: value.kind,
      execution: {
        ...value.execution,
        operationFingerprint: value.operationFingerprint,
        deadlineAt: requestedDeadlineAt,
        fingerprint: executionFingerprint({
          kind: value.kind,
          operationFingerprint: value.operationFingerprint,
          deadlineAt: requestedDeadlineAt,
          parent: retainedControlParent(handle.execution),
        }),
      },
      serviceIds: value.serviceIds,
      recipient: value.recipient,
    };
    if (
      requestedDeadlineAt <= boundAt ||
      requestedDeadlineAt > handle.execution.deadlineAt ||
      controlDigest(child) !== controlDigest(expected)
    )
      throw Error("Reserved phase exact identity mismatch");
  } else if (cell.delegation) throw Error("An unbound phase cannot have a grant");
  return cell;
}
export function lookupControlChildPhase(
  handle: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
): ControlPlannedChild | null {
  return cellOf(handle, progressOf(handle), input).binding?.child ?? null;
}
export async function bindControlChildPhase(
  handle: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
): Promise<ControlPlannedChild> {
  const retained = cellOf(handle, progressOf(handle), input);
  if (retained.binding) return retained.binding.child;
  const value = reservation(handle, input),
    boundAt = Date.now();
  const requestedDeadlineAt = Math.min(
    handle.execution.deadlineAt,
    boundAt + opsExecutionBudget(value.kind).processMs,
  );
  const normalized = normalizeExecutionAdmission({
    kind: value.kind,
    operationKey: value.execution.operationKey,
    operationFingerprint: value.operationFingerprint,
    admittedAt: boundAt,
    requestedDeadlineAt,
    parent: verifiedRetainedControlParent(handle.installation.installation, handle.execution),
  });
  const child: ControlPlannedChild = {
    phase: value.phase,
    ordinal: value.ordinal,
    kind: value.kind,
    execution: {
      ...value.execution,
      operationFingerprint: value.operationFingerprint,
      deadlineAt: normalized.deadlineAt,
      fingerprint: normalized.fingerprint,
    },
    serviceIds: [...value.serviceIds],
    recipient: value.recipient,
  };
  return withControlDelegationPublication(handle, input.phase, (progress) => {
    const current = cellOf(handle, progress, input);
    if (current.binding) return current.binding.child;
    current.binding = {
      child: { ...child, serviceIds: [...child.serviceIds] },
      boundAt,
      requestedDeadlineAt,
    };
    return child;
  });
}
/** Records the grant of a bound reserved child; called with the progress `withControlDelegationPublication` saves. */
export function prepareControlChildPublication(
  handle: ExecutionHandle,
  progress: ExecutionProgress,
  input: { phase: ControlChildPhase; ordinal: number },
  delegation: ControlDelegation,
): void {
  if (!handle.reservations.some((r) => r.phase === input.phase && r.ordinal === input.ordinal))
    return;
  const cell = cellOf(handle, progress, input);
  if (!cell.binding || cell.delegation)
    throw Error("Reserved phase publication requires observation");
  cell.delegation = delegation;
}
export function inspectControlChildPublication(
  handle: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = cellOf(handle, progressOf(handle), input);
  return {
    binding: cell.binding,
    publication: cell.delegation
      ? { state: "grant_prepared" as const, delegation: cell.delegation }
      : { state: "unissued" as const },
    bindingDigest: controlDigest(cell.binding),
  };
}
export function lookupControlChildPhaseBinding(
  handle: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = cellOf(handle, progressOf(handle), input);
  return cell.binding
    ? Object.freeze({ ...cell.binding, bindingDigest: controlDigest(cell.binding) })
    : null;
}
/** The child an attempted phase issued, for observation and cancellation only.
 * This returns no ticket and never repairs or reissues a missing attempt. */
export function lookupControlChildPhaseAttempt(
  handle: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = cellOf(handle, progressOf(handle), input);
  if (!cell.delegation) return null;
  if (!cell.binding) throw Error("Attempted phase has no exact binding");
  const delegation = cell.delegation;
  if (
    delegation.kind !== cell.binding.child.kind ||
    controlDigest(delegation.execution) !== controlDigest(cell.binding.child.execution) ||
    controlDigest(delegation.parent) !== controlDigest(handle.execution)
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
  handle: ExecutionHandle,
  input: { phase: ControlChildPhase; execution: ExecutionRef; recipient: ControlRecipient },
): ControlPlannedChild | undefined {
  const exact = handle.plan.find(
    (p) =>
      p.phase === input.phase &&
      p.recipient === input.recipient &&
      controlDigest(p.execution) === controlDigest(input.execution),
  );
  if (exact) return exact;
  const slot = handle.reservations.find(
    (r) => r.phase === input.phase && r.execution.operationKey === input.execution.operationKey,
  );
  if (!slot) return undefined;
  const bound = lookupControlChildPhase(handle, slot);
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
export function verifyLocalArtifactTargetRootRelease(handle: ExecutionHandle): void {
  if (!localRootReleased(handle)) throw Error("Original root release is not proved");
}
export function localRootReleased(handle: ExecutionHandle): boolean {
  verifyControlEffectSettlement(handle.installation.installation, handle.execution);
  return !requireLocalLeases(handle.installation.leases).readSync(rootLeaseId(handle.execution));
}
