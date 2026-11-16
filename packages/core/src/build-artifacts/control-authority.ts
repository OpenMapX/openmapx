import { dataWorkflowReceiptSchema } from "../ops/job-evidence";
import {
  configurationHandoffIntentRecordSchema,
  configurationHandoffProgressSchema,
  configurationHandoffRecordName,
  configurationHandoffWorkerRecordSchema,
} from "./configuration-handoff-records";
import {
  type ControlChildPhase,
  type ControlRecipient,
  childPhaseKinds,
  controlChildOperationKey,
} from "./control-child-records";
import { dataUpdatePlanSchema } from "./data-update-records";
import { dataUpdateSourcesDigest } from "./data-update-sources";
import {
  LOCAL_CREDENTIAL_TEMPLATE_KIND,
  localCredentialTemplateFileDigest,
  localCredentialTemplateOperationSchema,
  localCredentialTemplateReceiptSchema,
} from "./local-credential-template";

export {
  type ControlChildPhase,
  type ControlRecipient,
  childPhaseKinds,
  controlChildOperationKey,
} from "./control-child-records";

// biome-ignore lint/suspicious/noImportCycles: The failed receipt is read after initialization, never during module evaluation.
import { readFailedServiceLifecycleReceipt } from "../services/service-lifecycle-receipt";
import {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  digest,
  type InstallationState,
  sameControlOrigin,
  targetSchema,
  uuid,
} from "./control-records";
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import { leaseStoreDirectory, openLeaseStore } from "./lease-store";
import {
  closeArtifactTargetLeaseHandle,
  inspectLocalLeaseChildSettlement,
  type LeaseBackend,
  localLeaseBackend,
  restoreArtifactTargetLeaseForSettlement,
  verifyLocalArtifactTargetRootRelease,
} from "./target-lease";

// biome-ignore-end lint/suspicious/noImportCycles: Same exact deferred guard import.

export {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  digest,
  type InstallationState,
  sameControlOrigin,
  targetSchema,
  uuid,
} from "./control-records";

import { randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync, realpathSync, statfsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import type { PreparedConfigurationRecord } from "../ops/configuration-preparation";
import {
  type OpsJobStatus,
  type OpsOperationKind,
  opsOperationSchema,
  opsResourceId,
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
  opsExecutionMaximumMs,
  type RetainedParentExecution,
  retainedParentExecutionSchema,
} from "../ops/execution-identity";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { servicePullResultSchema } from "../ops/service-operation-records";
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
import {
  currentConfigurationGeneration,
  type OriginalConfigurationGenerationNonCommit,
  originalConfigurationGenerationNonCommitSource,
} from "../services/configuration-generation";
import { dataConfigurationFenceReceiptSchema } from "../services/data-manager/contracts/configuration-maintenance";
import { dataExecutionStatusSchema } from "../services/data-manager/contracts/executions";
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import {
  type ControlChildReservation,
  controlChildReservationSchema,
  initializeControlChildReservations,
  inspectControlChildPublication,
  lookupControlChildPhase,
  lookupControlChildPhaseAttempt,
  lookupControlChildPhaseBinding,
  prepareControlChildPublication,
  resolveControlChildPlan,
  validateControlChildReservations,
} from "./child-phase";
import {
  assertConfigurationMaintenanceDecisionSource,
  configurationMaintenanceOwnerRecordSchema,
} from "./configuration-maintenance-owner-records";
// biome-ignore-end lint/suspicious/noImportCycles: Live protocol dependency described above.
import {
  type CoordinatorPullBaseline,
  coordinatorPullBaselineSchema,
  coordinatorPullWitnessPayloadSchema,
  coordinatorPullWitnessSchema,
  stagedCoordinatorObservationPayloadSchema,
  stagedCoordinatorSourceSchema,
} from "./coordinator-pull-records";
// biome-ignore-start lint/suspicious/noImportCycles: Fixed proof verification uses this module's original nominal authority and effect writer after initialization.
import {
  inspectFeedProxyValidationFailure,
  recordFeedProxyReloadAttempted,
} from "./data-execution-candidate";
// biome-ignore-end lint/suspicious/noImportCycles: Fixed live proof dependency described above.
import { AnchoredDirectory, identity } from "./filesystem";
export const CONTROL_ROLES = ["ops-agent", "data-manager", "host-cli"] as const;
const PRIVATE_RECORD_BYTES = 131072;
declare const authorityBrand: unique symbol,
  peerBrand: unique symbol,
  settlementBrand: unique symbol,
  recoveryBrand: unique symbol,
  assertionBrand: unique symbol;
export type VerifiedExecutionAuthority = Readonly<{
  execution: ExecutionRef;
  [authorityBrand]: true;
}>;
export type VerifiedControlPeer = Readonly<{ [peerBrand]: true }>;
export type VerifiedChildSettlement = Readonly<{ [settlementBrand]: true }>;
export type VerifiedRecoveryAuthority = Readonly<{ [recoveryBrand]: true }>;
export type ArtifactDelegationAssertion = string & { readonly [assertionBrand]: true };
export type ChildSettlement = {
  identity: ExecutionRef;
  outcome: "contained" | "committed" | "failed_without_effect" | "unknown";
  publication: "not_started" | "committed" | "unknown";
  terminalReceiptDigest: string;
};
export type { ControlExecutionOrigin } from "../ops/control-root-key";

/** Where a role keeps its private control records: its own state directory. */
export function controlPrivateRoot(infraDir: string, role: ControlIssuer): string {
  return join(infraDir, "state", role, "control");
}
/** Data-manager's private records, as its container mounts them. */
export const DATA_MANAGER_CONTAINER_PRIVATE_ROOT = "/var/lib/openmapx/control";
/** Creates each role's private record directory; render and host commands call it. */
export function provisionControlDirectories(infraDir: string): void {
  const infra = new AnchoredDirectory(infraDir);
  try {
    const state = infra.directory("state", true);
    try {
      for (const role of CONTROL_ROLES) {
        const roleRoot = state.directory(role, true);
        try {
          roleRoot.directory("control", true, true).close();
        } finally {
          roleRoot.close();
        }
      }
    } finally {
      state.close();
    }
  } finally {
    infra.close();
  }
}
const installations = new WeakMap<object, InstallationState>();
/** The agent's own lease store, as its processes and the host CLI see it. */
export function agentStoreLeases(infraDir: string, role: ControlIssuer): LeaseBackend {
  return localLeaseBackend(
    openLeaseStore({ directory: leaseStoreDirectory(infraDir), purpose: role }),
  );
}
export function installationState(value: ControlInstallation): InstallationState {
  const state = installations.get(value);
  if (!state) throw Error("Unverified control installation");
  state.privateRoot.check();
  return state;
}
/** Who wrote a control record: a fixed child's id, or the role itself. */
export function controlIdentity(installation: ControlInstallation): string {
  return installationState(installation).fixedChildId ?? installation.role;
}
/** Called only at fixed host/service startup; infraDir is the configured installation, never a request field. */
export function openControlInstallation(options: {
  infraDir: string;
  role: ControlIssuer;
  serviceIds?: readonly string[];
  container?: boolean;
  /** Data-manager and the host CLI pass the agent's routes; others use its store. */
  leases?: LeaseBackend;
}): ControlInstallation {
  if (options.serviceIds?.length) targetSchema.parse([...new Set(options.serviceIds)].sort());
  const container = options.container === true && options.role === "data-manager";
  let privateRoot: AnchoredDirectory | undefined;
  try {
    privateRoot = new AnchoredDirectory(
      container
        ? DATA_MANAGER_CONTAINER_PRIVATE_ROOT
        : controlPrivateRoot(options.infraDir, options.role),
      undefined,
      true,
    );
    const dataRoot = container ? "/data" : join(options.infraDir, "data");
    const privateRelative = relative(realpathSync(dataRoot), realpathSync(privateRoot.path));
    if (!privateRelative || (!privateRelative.startsWith("../") && privateRelative !== ".."))
      throw Error("Role recovery material is inside the shared data mount");
    const data = new AnchoredDirectory(dataRoot);
    try {
      if (
        identity(data.stat).dev === identity(privateRoot.stat).dev &&
        identity(data.stat).ino === identity(privateRoot.stat).ino
      )
        throw Error("Role recovery material must be outside shared data");
    } finally {
      data.close();
    }
    const installation = Object.freeze({ role: options.role }) as ControlInstallation;
    installations.set(installation, {
      installation,
      privateRoot,
      dataRoot,
      registeredTargets: new Set(options.serviceIds ?? []),
      leases: options.leases ?? agentStoreLeases(options.infraDir, options.role),
    });
    privateRoot = undefined;
    return installation;
  } finally {
    privateRoot?.close();
  }
}
export function closeControlInstallation(installation: ControlInstallation) {
  const s = installationState(installation);
  s.privateRoot.close();
  installations.delete(installation);
}
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
export function writePrivateRecord(
  state: InstallationState,
  namespace: string,
  name: string,
  value: unknown,
  exclusive = false,
) {
  const dir = state.privateRoot.directory(namespace, true, true);
  try {
    const bytes = canonicalJson(value);
    if (Buffer.byteLength(bytes) > (namespace === "hardlinks" ? 1024 * 1024 : PRIVATE_RECORD_BYTES))
      throw Error("Private receipt limit");
    if (
      ![
        "executions",
        "children",
        "effects",
        "effect-started",
        "observations",
        "leases",
        "execution-leases",
        "attempts",
        "adoptions",
        "parent-attempts",
        "parent-adoptions",
        "execution-parents",
        "execution-lifecycle",
        "lifecycle-observations",
        "spawns",
        "spawn-started",
        "prepared",
        "execution-adoptions",
        "configuration-maintenance",
        "hardlinks",
        "catalog-commits",
      ].includes(namespace)
    )
      throw Error("Unknown fixed authority namespace");
    dir.write(name, bytes, exclusive);
  } finally {
    dir.close();
  }
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
const terminalCommitmentSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["prepared", "canonical"]),
  origin: controlOriginSchema,
  execution: executionRefSchema,
  admissionDigest: digest,
  terminalDigest: digest,
  terminalAt: z.number().int().positive().safe(),
});
const terminalCommitmentName = (execution: ExecutionRef) =>
  `terminal-${execution.operationKey}.json`;
function terminalIdentity(s: AuthorityState, status: OpsJobStatus) {
  const terminal = parseOpsJobStatus(status),
    execution = s.execution;
  const raw = readPrivateRecord(
    s.installation,
    "executions",
    `${execution.operationKey}.json`,
    65536,
  );
  const admitted = z
    .object({ admittedAt: z.number().int().nonnegative().safe(), operation: opsOperationSchema })
    .passthrough()
    .parse(raw);
  if (
    s.installation.installation.role !== "ops-agent" ||
    s.installation.fixedChildId ||
    terminal.admittedAt !== admitted.admittedAt ||
    terminal.operationId !== execution.executionId ||
    terminal.operationKey !== execution.operationKey ||
    terminal.fingerprint !== execution.fingerprint ||
    terminal.deadlineAt !== execution.deadlineAt ||
    terminal.kind !== s.kind
  )
    throw Error("Original terminal identity required");
  return { terminal, admitted, digest: controlTerminalReceiptDigest(terminal) };
}
function readTerminalCommitment(s: AuthorityState) {
  const proof = terminalCommitmentSchema.parse(
    readPrivateRecord(s.installation, "observations", terminalCommitmentName(s.execution), 4096),
  );
  if (
    proof.admissionDigest !== s.receiptDigest ||
    controlDigest(proof.execution) !== controlDigest(s.execution) ||
    !sameControlOrigin(proof.origin, s.origin)
  )
    throw Error("Original terminal commitment identity changed");
  return proof;
}
/** Fixed live producer only: sign the full canonical tuple digest and original
 * time before its public journal row. This record makes no containment claim. */
export function retainControlTerminalCommitment(
  authority: VerifiedExecutionAuthority,
  status: OpsJobStatus,
  terminalAt: number,
): number {
  const s = executionAuthorityState(authority),
    value = terminalIdentity(s, status),
    origin = s.origin;
  if (!origin || !Number.isSafeInteger(terminalAt) || terminalAt < value.admitted.admittedAt)
    throw Error("Invalid original terminal time");
  return withPrivateEffectWriter(s, () => {
    const raw = readPrivateRecord(
      s.installation,
      "observations",
      terminalCommitmentName(s.execution),
      4096,
    );
    const prior = raw === null ? undefined : readTerminalCommitment(s);
    const originalTime = prior?.terminalAt ?? terminalAt;
    if (prior) {
      if (prior.terminalDigest === value.digest) return originalTime;
      // Configuration results stay masked while confidential claim cleanup
      // refines their prepared result. A canonical receipt is never replaceable.
      if (prior.phase !== "prepared" || !("revisionId" in value.admitted.operation))
        throw Error("Original terminal tuple conflict");
    }
    const payload = terminalCommitmentSchema.parse({
      version: 1,
      phase: "prepared",
      origin,
      execution: s.execution,
      admissionDigest: s.receiptDigest,
      terminalDigest: value.digest,
      terminalAt: originalTime,
    });
    writePrivateRecord(
      s.installation,
      "observations",
      terminalCommitmentName(s.execution),
      payload,
      false,
    );
    return originalTime;
  });
}
function verifyAndSealTerminalCommitment(
  s: AuthorityState,
  status: OpsJobStatus,
  terminalAt?: number,
) {
  const value = terminalIdentity(s, status),
    proof = readTerminalCommitment(s),
    origin = s.origin;
  if (
    !origin ||
    proof.terminalDigest !== value.digest ||
    (terminalAt !== undefined && proof.terminalAt !== terminalAt)
  )
    throw Error("Original canonical terminal tuple/time changed");
  if (proof.phase === "prepared")
    writePrivateRecord(
      s.installation,
      "observations",
      terminalCommitmentName(s.execution),
      {
        ...proof,
        phase: "canonical" as const,
      },
      false,
    );
  return proof;
}
export function retainControlTerminalStatus(
  installation: ControlInstallation,
  execution: ExecutionRef,
  status: OpsJobStatus,
  terminalAt?: number,
): void {
  const authority = restoreAdmittedControlExecution(installation, execution),
    s = executionAuthorityState(authority);
  withPrivateEffectWriter(s, () => {
    verifyAndSealTerminalCommitment(s, status, terminalAt);
  });
}
/** Rejoin a terminal worker from its original signed admission and known effect
 * receipt. The fixed startup adapter separately proves borrowed/claim cleanup. */
export function repairControlJournalTerminal(
  installation: ControlInstallation,
  execution: ExecutionRef,
  status: OpsJobStatus,
  terminalAt: number,
): VerifiedExecutionAuthority {
  const authority = restoreAdmittedControlExecution(installation, execution),
    s = executionAuthorityState(authority);
  const terminal = parseOpsJobStatus(status);
  if (
    installation.role !== "ops-agent" ||
    s.installation.fixedChildId ||
    terminal.operationId !== execution.executionId ||
    terminal.operationKey !== execution.operationKey ||
    terminal.fingerprint !== execution.fingerprint ||
    terminal.deadlineAt !== execution.deadlineAt ||
    terminal.kind !== s.kind ||
    !Number.isSafeInteger(terminalAt) ||
    terminalAt < terminal.admittedAt
  )
    throw Error("Original terminal journal identity required");
  withPrivateEffectWriter(s, () => {
    const admittedRaw = readPrivateRecord(
      s.installation,
      "executions",
      `${execution.operationKey}.json`,
      65536,
    );
    const admitted = z
      .object({ admittedAt: z.number().int().nonnegative().safe() })
      .passthrough()
      .parse(admittedRaw);
    if (admitted.admittedAt !== terminal.admittedAt) throw Error("Original admission time changed");
    verifyControlEffectSettlement(installation, execution);
    const proof = settlementSchema
      .extend({ receipt: effectObservationSchema })
      .parse(readPrivateRecord(s.installation, "effects", `${execution.operationKey}.json`));
    const succeeded =
      terminal.state === "succeeded" &&
      proof.outcome === "committed" &&
      proof.publication === "committed" &&
      proof.receipt.kind === "ops-result" &&
      controlDigest(proof.receipt.result) === controlDigest(terminal.result);
    const failedWithoutEffect =
      ["failed", "timed_out"].includes(terminal.state) &&
      proof.outcome === "failed_without_effect" &&
      proof.publication === "not_started" &&
      proof.receipt.kind === "not-started";
    const validationFailed =
      terminal.state === "failed" &&
      s.kind === "feedProxy.validateAndReload" &&
      proof.outcome === "contained" &&
      proof.publication === "not_started" &&
      proof.receipt.kind === "feed-proxy-validation-failure" &&
      inspectFeedProxyValidationFailure(authority, proof.receipt.commitmentDigest) !== null;
    const generationNotCommitted =
      terminal.state === "succeeded" &&
      proof.outcome === "contained" &&
      proof.publication === "not_started" &&
      proof.receipt.kind === "configuration-generation-not-committed" &&
      canonicalJson(proof.receipt.result) === canonicalJson(terminal.result) &&
      canonicalJson(inspectConfigurationGenerationNonCommit(installation, execution)) ===
        canonicalJson(proof.receipt);
    if (!succeeded && !failedWithoutEffect && !validationFailed && !generationNotCommitted)
      throw Error("Terminal worker containment is not proved");
    verifyAndSealTerminalCommitment(s, terminal, terminalAt);
  });
  return authority;
}
/** Reserves the execution's terminal commitment record before any effect. */
export function reserveControlTerminal(authority: VerifiedExecutionAuthority): void {
  const s = executionAuthorityState(authority);
  // Reserve the immutable terminal authentication cell before any effect.
  writePrivateRecord(
    s.installation,
    "observations",
    terminalCommitmentName(s.execution),
    null,
    true,
  );
}
export function assertFreshControlRoot(key: string, requestedDeadlineAt: number | undefined): void {
  const parsed = parseControlRootOperationKey(key);
  if (requestedDeadlineAt !== parsed.notAfter || parsed.notAfter - Date.now() > 7 * 24 * 3600_000)
    throw Error("A timed control root with its exact deadline is required");
  // An expired root is refused whether or not its records were already pruned.
  if (parsed.notAfter <= Date.now()) throw Error("Expired control root");
}
/** Refuses new control work, before any effect, when the role's private
 * state filesystem has less than 64 MiB free. */
export function assertControlStorageAvailable(installation: ControlInstallation): void {
  const { bavail, bsize } = statfsSync(installationState(installation).privateRoot.anchor);
  if (bavail * bsize < 64 * 1024 * 1024)
    throw Error("Control state filesystem is nearly full; free space before retrying");
}
export function controlInstallationDataRoot(installation: ControlInstallation): string {
  return installationState(installation).dataRoot;
}
/** Fixed agent registry refresh after a repository publication/removal. This
 * local admission cache is populated from the literal trusted service loader,
 * never an operation's requested IDs. Retained roots keep their signed targets. */
export function replaceControlRegisteredServiceIds(
  installation: ControlInstallation,
  serviceIds: readonly string[],
): void {
  const state = installationState(installation);
  if (installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Agent registry refresh required");
  state.registeredTargets = new Set(targetSchema.parse([...new Set(serviceIds)].sort()));
}
export function controlRegisteredServiceIds(installation: ControlInstallation): string[] {
  return [...installationState(installation).registeredTargets].sort();
}
export function readPrivateRecord(
  state: InstallationState,
  namespace: string,
  name: string,
  max: number = PRIVATE_RECORD_BYTES,
): unknown {
  const dir = state.privateRoot.directory(namespace);
  try {
    return JSON.parse(dir.read(name, max).toString("utf8"));
  } finally {
    dir.close();
  }
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
    serviceIds: readonly string[];
    plan?: readonly ControlPlannedChild[];
    reservations?: readonly ControlChildReservation[];
    coordinatorPullBaseline?: CoordinatorPullBaseline;
  },
): VerifiedExecutionAuthority {
  const state = installationState(installation);
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
  publishControlExecutionWitness(
    state,
    { execution, kind: input.kind, serviceIds, origin },
    controlDigest(receipt),
  );
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
  assertion: string;
  /** The recipient: a role name, or a fixed child's id. */
  childId: string;
}
const peers = new WeakMap<object, PeerState>();
export function controlPeerState(peer: VerifiedControlPeer) {
  const s = peers.get(peer);
  if (!s) throw Error("Unverified control peer");
  return s;
}
const delegatedRowSchema = z.strictObject({
  key: uuid,
  parentKey: uuid.nullable(),
  parent: executionRefSchema,
  execution: executionRefSchema,
  kind: z.string().max(128),
  phase: z.string().max(64),
  recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
  targets: targetSchema,
});
/**
 * A child row of the agent's lease store, sent to the child's recipient. A
 * recipient that reads the store checks the row there; data-manager cannot and
 * trusts the caller it authenticated by token instead.
 */
const assertionSchema = z
  .strictObject({
    version: z.literal(2),
    leaseId: uuid,
    delegationId: uuid,
    grantDigest: digest,
    owner: executionRefSchema,
    origin: controlOriginSchema,
    grant: delegatedRowSchema,
  })
  .refine(
    (value) =>
      value.grant.key === value.delegationId && controlDigest(value.grant) === value.grantDigest,
  );
export function encodeControlAssertion(
  fields: Omit<z.infer<typeof assertionSchema>, "version" | "grantDigest">,
): ArtifactDelegationAssertion {
  return Buffer.from(
    canonicalJson(
      assertionSchema.parse({ version: 2, ...fields, grantDigest: controlDigest(fields.grant) }),
    ),
  ).toString("base64url") as ArtifactDelegationAssertion;
}
/**
 * The delegation data-manager received from the agent or the host CLI. The
 * caller's token says who sent it; data-manager never reads the lease store.
 */
export function inspectRemoteDelegation(
  installation: ControlInstallation,
  rawHeaders: readonly string[],
  transportPrincipal: ControlTransportPrincipal,
) {
  if (installation.role !== "data-manager") throw Error("Data-manager receiver required");
  const { delegation, parent } = controlHeaders(rawHeaders);
  if (!delegation || parent) throw Error("Delegation required");
  const parsed = parseControlAssertion(delegation),
    issuer = parsed.grant.parent.executor;
  if (
    parsed.grant.recipient !== "data-manager" ||
    parsed.grant.execution.executor !== "data-manager" ||
    !(
      (transportPrincipal === "ops-agent" && (issuer === "ops-agent" || issuer === "host-cli")) ||
      (transportPrincipal === "host-cli" && issuer === "host-cli")
    )
  )
    throw Error("Delegation caller mismatch");
  const verifiedParent = Object.freeze(
    retainedControlParent(parsed.grant.parent),
  ) as import("../ops/execution-identity").VerifiedParentExecution;
  verifiedParents.add(verifiedParent);
  verifiedParentOrigins.set(verifiedParent, parsed.origin);
  return Object.freeze({
    assertion: delegation,
    leaseId: parsed.leaseId,
    delegationId: parsed.delegationId,
    owner: parsed.owner,
    origin: parsed.origin,
    parent: parsed.grant.parent,
    verifiedParent,
    execution: parsed.grant.execution,
    kind: parsed.grant.kind,
    phase: parsed.grant.phase,
    serviceIds: Object.freeze([...parsed.grant.targets]),
  });
}
export function parseControlAssertion(assertion: string) {
  if (Buffer.byteLength(assertion) > 4096 || !/^[A-Za-z0-9_-]+$/.test(assertion))
    throw Error("Invalid control assertion encoding/limit");
  const bytes = Buffer.from(assertion, "base64url");
  if (bytes.toString("base64url") !== assertion) throw Error("Invalid control assertion encoding");
  const parsed = assertionSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (Buffer.from(canonicalJson(parsed)).toString("base64url") !== assertion)
    throw Error("Noncanonical control assertion");
  return parsed;
}
export function controlHeaders(rawHeaders: readonly string[]): {
  delegation?: string;
  parent?: string;
} {
  const found = new Map<string, string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]?.toLowerCase();
    if (!["x-openmapx-control-delegation", "x-openmapx-parent-execution"].includes(name)) continue;
    if (found.has(name) || typeof rawHeaders[i + 1] !== "string")
      throw Error("Duplicate control header");
    const value = rawHeaders[i + 1];
    if (value === undefined) throw Error("Missing control header value");
    found.set(name, value);
  }
  const delegation = found.get("x-openmapx-control-delegation"),
    parent = found.get("x-openmapx-parent-execution");
  if (
    (delegation?.length ?? 0) + (parent?.length ?? 0) > 8192 ||
    (delegation?.length ?? 0) > 4096 ||
    (parent?.length ?? 0) > 4096
  )
    throw Error("Control header limit");
  return { delegation, parent };
}
/** The caller a receiver authenticated by its own bearer token. */
export type ControlTransportPrincipal = "data-manager" | "api" | "ops-agent" | "host-cli";
/** Transport authentication is required by the fixed caller. Record checks finish during anchored adoption. */
export function verifyControlPeer(
  installation: ControlInstallation,
  input: {
    rawHeaders: readonly string[];
    transportPrincipal: ControlTransportPrincipal;
    execution: ExecutionRef;
    kind: string;
  },
): VerifiedControlPeer {
  const state = installationState(installation);
  const headers = controlHeaders(input.rawHeaders);
  const assertionText = headers.delegation ?? headers.parent;
  if (!assertionText) throw Error("Missing control assertion");
  if (headers.delegation) parseControlAssertion(assertionText);
  else parseParentAssertion(assertionText);
  if (installation.role === "ops-agent" && input.transportPrincipal !== "data-manager")
    throw Error("Wrong peer transport principal");
  if (installation.role === "host-cli") throw Error("Host CLI is not an HTTP receiver");
  if (installation.role === "data-manager" && input.transportPrincipal === "data-manager")
    throw Error("Wrong peer transport principal");
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: installation.role === "ops-agent" ? "data-manager" : "ops-agent",
    recipient: installation.role,
    execution: executionRefSchema.parse(input.execution),
    kind: input.kind,
    assertion: assertionText,
    childId: installation.role,
  });
  return peer;
}
/** Same-agent maintenance continuations must match this role's private attempted intent. */
export function verifyRetainedLocalControlPeer(
  installation: ControlInstallation,
  input: { assertion: string; execution: ExecutionRef; kind: string },
): VerifiedControlPeer {
  const state = installationState(installation);
  const assertion = parseControlAssertion(input.assertion);
  if (installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Local agent continuation required");
  const saved = z
    .object({
      assertion: z.string(),
      grant: z.object({ execution: executionRefSchema, kind: z.string() }),
    })
    .parse(readPrivateRecord(state, "attempts", `${assertion.delegationId}.json`));
  if (
    saved.assertion !== input.assertion ||
    saved.grant.kind !== input.kind ||
    controlDigest(saved.grant.execution) !== controlDigest(input.execution)
  )
    throw Error("Local continuation intent mismatch");
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: "ops-agent",
    local: true,
    recipient: "ops-agent",
    execution: input.execution,
    kind: input.kind,
    assertion: input.assertion,
    childId: installation.role,
  });
  return peer;
}
export function prepareFixedControlChild(
  authority: VerifiedExecutionAuthority,
  delegationId: string,
): string {
  uuid.parse(delegationId);
  const s = executionAuthorityState(authority);
  if (s.installation.installation.role !== "ops-agent")
    throw Error("Only agent prepares fixed children");
  withExecutionWriter(s.installation, s.execution, (dir) => {
    const name = `${s.execution.operationKey}.keys.json`;
    let ids: string[] = [];
    try {
      ids = z
        .array(uuid)
        .max(64)
        .parse(JSON.parse(dir.read(name, 4096).toString("utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (
      ids.length >= Math.min(64, s.plan.length + s.reservations.length) ||
      ids.includes(delegationId)
    )
      throw Error("Fixed child capacity/replay");
    dir.write(name, canonicalJson([...ids, delegationId]));
  });
  writePrivateRecord(
    s.installation,
    "children",
    `${delegationId}.json`,
    { delegationId, execution: s.execution },
    true,
  );
  return delegationId;
}
const fixedChildSchema = z.strictObject({ delegationId: uuid, execution: executionRefSchema });
export function fixedControlChildId(
  state: InstallationState,
  childId: string,
  parent: ExecutionRef,
): string {
  const saved = fixedChildSchema.parse(
    readPrivateRecord(state, "children", `${uuid.parse(childId)}.json`, 2048),
  );
  if (saved.delegationId !== childId || controlDigest(saved.execution) !== controlDigest(parent))
    throw Error("Fixed child parent mismatch");
  return saved.delegationId;
}
export function verifyFixedCliControlPeer(
  installation: ControlInstallation,
  input: {
    assertion: string;
    execution: ExecutionRef;
    kind: string;
    recipient?: "fixed-cli" | "configuration-helper";
  },
): VerifiedControlPeer {
  const state = installationState(installation);
  const encoded = JSON.parse(Buffer.from(input.assertion, "base64url").toString("utf8")) as {
    leaseId?: unknown;
  };
  const assertion = encoded.leaseId
    ? parseControlAssertion(input.assertion)
    : parseParentAssertion(input.assertion);
  const fixedId = "delegationId" in assertion ? assertion.delegationId : assertion.attemptId;
  if (installation.role !== "ops-agent") throw Error("Invalid fixed CLI installation");
  fixedChildSchema.parse(readPrivateRecord(state, "children", `${uuid.parse(fixedId)}.json`, 2048));
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: "ops-agent",
    recipient: input.recipient ?? "fixed-cli",
    execution: executionRefSchema.parse(input.execution),
    kind: input.kind,
    assertion: input.assertion,
    childId: fixedId,
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
/** No fence exists for this maintenance owner: its fence child was never
 * issued, or the data-manager settled it without effect (a refusal, or the
 * observation that the prepare was never admitted). */
function verifyConfigurationFenceNotPrepared(authority: VerifiedExecutionAuthority): void {
  const s = executionAuthorityState(authority),
    reservation = s.reservations.find((slot) => slot.phase === "configuration-fence");
  if (!reservation) throw Error("Original fence preparation reservation required");
  const binding = lookupControlChildPhaseBinding(authority, reservation);
  if (
    !binding &&
    inspectControlChildPublication(authority, reservation).publication.state === "unissued"
  )
    return;
  if (!binding) throw Error("Original fence preparation binding required");
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    const settled = inspectLocalLeaseChildSettlement(lease, binding.child.execution);
    if (settled?.outcome !== "failed_without_effect")
      throw Error("Data-manager fence refusal required");
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
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
/** Recover only the exact failure ALREADY fixed by the original signed
 * terminal commitment. The interrupted journal is a locator, never authority;
 * neither a new error/time nor an uncommitted failure can pass this comparison. */
export function restoreConfigurationPreEffectTerminal(
  installation: ControlInstallation,
  execution: ExecutionRef,
  observed: OpsJobStatus,
): { status: OpsJobStatus; terminalAt: number } {
  const authority = restoreAdmittedControlExecution(installation, execution);
  inspectConfigurationPreEffectRefusal(authority);
  const state = configurationPreEffectState(authority),
    proof = readTerminalCommitment(state),
    proofName = terminalCommitmentName(state.execution),
    rawProof = readPrivateRecord(state.installation, "observations", proofName, 4096);
  if (controlDigest(rawProof) !== controlDigest(proof))
    throw Error("Original pre-effect terminal changed");
  const rawAdmission = readPrivateRecord(
    state.installation,
    "executions",
    `${execution.operationKey}.json`,
    65536,
  );
  if (controlDigest(rawAdmission) !== state.receiptDigest)
    throw Error("Original pre-effect admission changed");
  const admitted = z
    .object({ admittedAt: z.number().int().nonnegative().safe(), operation: opsOperationSchema })
    .passthrough()
    .parse(rawAdmission);
  if ("revisionId" in admitted.operation || proof.terminalAt < admitted.admittedAt)
    throw Error("Immutable original pre-effect tuple required");
  // Startup may have added an expiry cancellation projection. Only the
  // original signed whole-tuple digest decides whether it was present.
  for (const terminationRequestedAt of new Set([undefined, observed.terminationRequestedAt])) {
    const status = parseOpsJobStatus({
      version: 2,
      admittedAt: admitted.admittedAt,
      deadlineAt: execution.deadlineAt,
      fingerprint: execution.fingerprint,
      operationId: execution.executionId,
      operationKey: execution.operationKey,
      kind: admitted.operation.kind,
      resourceId: opsResourceId(admitted.operation),
      state: "failed",
      submittedAt: new Date(admitted.admittedAt).toISOString(),
      updatedAt: new Date(proof.terminalAt).toISOString(),
      errorClass:
        admitted.operation.kind === "service.pull" ? "busy" : "configuration_prerequisite",
      failureResult: {},
      ...(terminationRequestedAt === undefined ? {} : { terminationRequestedAt }),
    });
    if (controlTerminalReceiptDigest(status) === proof.terminalDigest) {
      terminalIdentity(state, status);
      return { status, terminalAt: proof.terminalAt };
    }
  }
  throw Error("Original pre-effect terminal unavailable");
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
    let outcome: ChildSettlement["outcome"] = "unknown",
      publication: ChildSettlement["publication"] = "unknown";
    if (receipt.kind === "catalog-pins-initialized") {
      if (
        s.kind !== "catalog-pins.initialize" ||
        s.installation.fixedChildId ||
        !["ops-agent", "host-cli"].includes(s.installation.installation.role)
      )
        throw Error("Original local catalog initialization required");
      const source = z
        .strictObject({
          version: z.literal(1),
          execution: executionRefSchema,
          generationId: digest.nullable(),
          pointerDigest: digest.nullable(),
        })
        .parse(
          readPrivateRecord(
            s.installation,
            "catalog-commits",
            `initialization-${s.execution.operationKey}.json`,
            65536,
          ),
        );
      if (
        controlDigest(source.execution) !== controlDigest(s.execution) ||
        source.generationId !== receipt.generationId
      )
        throw Error("Catalog initialization source mismatch");
      outcome = "committed";
      publication = "committed";
    } else if (receipt.kind === "feed-credential-template-written") {
      if (
        s.kind !== LOCAL_CREDENTIAL_TEMPLATE_KIND ||
        s.installation.fixedChildId ||
        s.installation.installation.role !== "host-cli"
      )
        throw Error("Original local credential template required");
      const name = `${s.execution.operationKey}.json`,
        started = readPrivateRecord(s.installation, "effect-started", name);
      if (
        !started ||
        controlDigest((started as { execution: unknown }).execution) !==
          controlDigest(s.execution) ||
        (started as { receiptDigest: unknown }).receiptDigest !== s.receiptDigest
      )
        throw Error("Original started credential template required");
      const admitted = readPrivateRecord(s.installation, "executions", name, 65536) as {
        operation: unknown;
      };
      const operation = localCredentialTemplateOperationSchema.parse(admitted.operation);
      if (
        receipt.fileDigest !== operation.fileDigest ||
        localCredentialTemplateFileDigest(s.installation, operation) !== operation.fileDigest
      )
        throw Error("Credential template file evidence changed");
      outcome = "committed";
      publication = "committed";
    } else if (receipt.kind === "service-lifecycle-contained-failure") {
      // The lease refuses release while a child it issued is unsettled, so the
      // failed receipt alone names what this failure contained.
      if (
        controlDigest(readFailedServiceLifecycleReceipt(authority)) !== receipt.failedReceiptDigest
      )
        throw Error("Original failed lifecycle source changed");
      outcome = "contained";
      publication = "committed";
    } else if (receipt.kind === "ops-result") {
      receipt.result = parseBoundedOpsResult(s.kind as OpsOperationKind, receipt.result);
      if (s.kind === "data.update") {
        const actual = readDataWorkflowProgress(authority),
          result = receipt.result as { dataWorkflow?: unknown };
        if (
          actual.phase !== "complete" ||
          actual.children.length !== 3 ||
          actual.children.some((c) => c.status !== "succeeded") ||
          actual.failedBuildIds.length ||
          actual.skippedBuildIds.length ||
          !actual.revisionId ||
          canonicalJson(actual) !== canonicalJson(result.dataWorkflow)
        )
          throw Error("Actual completed Full Update workflow required");
        verifyDataUpdateCompletionSource(authority, actual);
      }
      const result = receipt.result as { outcome?: string };
      // The fixed prepared publisher resolves only after complete restoration
      // or a pre-publication refusal. Uncertain restoration throws and cannot
      // manufacture this typed local result through the request envelope.
      if (s.kind === "artifactTransfer.import" && result.outcome === "not_committed") {
        outcome = "contained";
        publication = "not_started";
      }
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
      ) {
        outcome = "committed";
        publication = "committed";
      }
    } else if (receipt.kind === "reported-failure") {
      if (!REPORTED_FAILURE_KINDS.has(s.kind) || s.installation.installation.role !== "ops-agent")
        throw Error("Only a leased agent Docker effect reports its own failure");
      outcome = "contained";
      publication = "committed";
    } else if (receipt.kind === "feed-proxy-validation-failure") {
      if (
        s.kind !== "feedProxy.validateAndReload" ||
        inspectFeedProxyValidationFailure(authority, receipt.commitmentDigest) === null
      )
        throw Error("Original contained validation failure required");
      outcome = "contained";
      publication = "not_started";
    } else if (receipt.kind === "data-command") {
      const slots = s.reservations.filter(
        (slot) => slot.recipient === "data-manager" && slot.phase === "data-step",
      );
      if (slots.length !== 1) throw Error("Exact single data command required");
      const bound = lookupControlChildPhase(authority, slots[0]!);
      if (
        !bound ||
        bound.execution.executionId !== receipt.status.id ||
        bound.execution.fingerprint !== receipt.status.fingerprint
      )
        throw Error("Bound data command identity required");
      verifyDeadlineEdge(s.kind, "data-step", "data-manager", receipt.status.kind);
      readDataControlTerminalObservation(
        s.installation.installation,
        bound.execution,
        receipt.status,
      );
      if (receipt.status.status === "ok") {
        outcome = "committed";
        publication = "committed";
      }
    } else if (receipt.kind === "configuration-helper-completion") {
      if (s.kind !== "configuration-helper" || !s.installation.fixedChildId)
        throw Error("Original fixed configuration helper required");
      const admitted = readPrivateRecord(
          s.installation,
          "executions",
          `${s.execution.operationKey}.json`,
          65536,
        ) as { operation: unknown },
        body = z
          .strictObject({
            kind: z.literal("configuration-helper"),
            handoffId: uuid,
            intentDigest: digest,
          })
          .parse(admitted.operation),
        intent = readConfigurationHandoffSpawnIntent(
          s.installation.installation,
          s.execution,
          body.handoffId,
        ),
        progressName = configurationHandoffRecordName(body.handoffId, "progress"),
        progressRaw = readPrivateRecord(s.installation, "observations", progressName),
        progress = configurationHandoffProgressSchema.parse(progressRaw),
        completionName = configurationHandoffRecordName(body.handoffId, "completion"),
        completionRaw = readPrivateRecord(s.installation, "observations", completionName),
        completion = configurationHandoffWorkerRecordSchema.parse(completionRaw),
        spawnName = `${s.installation.fixedChildId}.json`,
        spawn = readPrivateRecord(s.installation, "spawn-started", spawnName) as {
          execution: unknown;
        },
        startedName = `${s.execution.operationKey}.json`,
        started = readPrivateRecord(s.installation, "effect-started", startedName) as {
          execution: unknown;
          receiptDigest: unknown;
        };
      if (
        body.intentDigest !== controlDigest(intent.operation) ||
        controlDigest(spawn.execution) !== controlDigest(s.execution) ||
        controlDigest(started.execution) !== controlDigest(s.execution) ||
        started.receiptDigest !== s.receiptDigest ||
        progress.intentDigest !== controlDigest(intent) ||
        progress.phase !== "launched" ||
        progress.launch.state !== "confirmed" ||
        completion.intentDigest !== controlDigest(intent) ||
        completion.preparationDigest !== controlDigest(progress) ||
        controlDigest(completion.execution) !== controlDigest(s.execution) ||
        completion.phase !== "applied" ||
        completion.completedAt === null ||
        completion.launch.containerId !== progress.launch.containerId ||
        receipt.completionDigest !== controlDigest(completion) ||
        completion.targets.length !== intent.operation.serviceIds.length ||
        completion.targets.some(
          (target) =>
            !intent.operation.serviceIds.includes(target.serviceId) ||
            target.expectedImageId !== intent.operation.expectedImageIdentities[target.serviceId] ||
            target.oldContainerId !==
              progress.targets.find((original) => original.serviceId === target.serviceId)
                ?.oldContainerId,
        )
      )
        throw Error("Actual original helper completion required");
      outcome = "committed";
      publication = "committed";
    } else if (receipt.kind === "fixed-cli-exit") {
      if (!s.installation.fixedChildId)
        throw Error("Fixed command receipt requires certified child");
      readFixedCliSpawnIntent(s.installation.installation, s.execution, receipt.args);
      readPrivateRecord(s.installation, "spawn-started", `${s.installation.fixedChildId}.json`);
      for (const slot of s.reservations.filter(
        (item) =>
          item.recipient === "data-manager" &&
          ["data-step", "osm", "transit", "fonts"].includes(item.phase),
      )) {
        const binding = lookupControlChildPhase(authority, slot);
        if (
          !binding ||
          readDataControlTerminalObservation(s.installation.installation, binding.execution).status
            .status !== "ok"
        )
          throw Error("Actual backend data containment required before fixed command success");
      }
      if (s.kind === "data.update") {
        for (const slot of s.reservations.filter((value) => value.phase === "hardlinks")) {
          const bound = lookupControlChildPhase(authority, slot);
          if (
            !bound ||
            readDataControlTerminalObservation(s.installation.installation, bound.execution).status
              .status !== "ok"
          )
            throw Error("Actual Full Update hardlink containment required");
        }
        const workflow = readDataWorkflowProgress(authority),
          spawn = readFixedCliSpawnIntent(s.installation.installation, s.execution, receipt.args);
        const expected =
          spawn.dataUpdatePlan?.dataReservation.execution.operationKey === s.execution.operationKey
            ? "build"
            : "complete";
        if (workflow.phase !== expected) throw Error("Original Full Update checkpoint required");
      }
      outcome = "committed";
      publication = "committed";
    } else if (receipt.kind === "configuration-fence-not-prepared") {
      if (
        s.kind !== "configurationMaintenance.prepare" ||
        s.installation.fixedChildId ||
        s.installation.installation.role !== "ops-agent" ||
        (
          readPrivateRecord(
            s.installation,
            "executions",
            `${s.execution.operationKey}.json`,
            65536,
          ) as { operation?: { maintenanceId?: string } }
        ).operation?.maintenanceId !== receipt.maintenanceId
      )
        throw Error("Original maintenance owner required");
      verifyConfigurationFenceNotPrepared(authority);
      outcome = "failed_without_effect";
      publication = "not_started";
    } else if (receipt.kind === "not-started") {
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
      if (s.installation.fixedChildId) throw Error("Fixed child cannot assert unused execution");
      outcome = "failed_without_effect";
      publication = "not_started";
    }
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
    owner = executionAuthorityState(authority),
    canonical = readTerminalCommitment(owner),
    settled = verifyControlEffectSettlement(installation, admitted.execution),
    effect = settlementSchema
      .extend({ receipt: effectObservationSchema })
      .parse(readPrivateRecord(local, "effects", `${fixed.root.operationKey}.json`));
  if (
    canonical.phase !== "canonical" ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    (parseBoundedOpsResult("service.start", effect.receipt.result) as { changed: boolean })
      .changed !== true
  )
    throw Error("Conclusive successful coordinator prerequisite required");
  verifyLocalArtifactTargetRootRelease(authority);
  return Object.freeze({
    execution: Object.freeze(admitted.execution),
    terminalDigest: canonical.terminalDigest,
    terminalAt: canonical.terminalAt,
    effectSettlementDigest: controlDigest(childSettlementState(settled).evidence),
  });
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
    canonical = readTerminalCommitment(state),
    terminal = terminalIdentity(state, input),
    settlement = verifyControlEffectSettlement(installation, execution),
    effectRecord = readPrivateRecord(local, "effects", `${execution.operationKey}.json`),
    effect = settlementSchema.extend({ receipt: effectObservationSchema }).parse(effectRecord);
  if (
    canonicalJson(state.origin) !== canonicalJson(admitted.origin) ||
    canonical.phase !== "canonical" ||
    terminal.terminal.state !== "succeeded" ||
    canonical.terminalDigest !== terminal.digest ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    canonicalJson(terminal.terminal.result) !== canonicalJson(effect.receipt.result)
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
      canonicalDigest: canonical.terminalDigest,
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
  const admitted = readPrivateRecord(
    state.installation,
    "executions",
    `${state.execution.operationKey}.json`,
    65536,
  ) as { operation?: { maintenanceId?: string } };
  const name = `${uuid.parse(admitted.operation?.maintenanceId)}.json`,
    raw = readPrivateRecord(state.installation, "configuration-maintenance", name);
  const owner = configurationMaintenanceOwnerRecordSchema.parse(raw);
  const observation = stagedCoordinatorObservationPayloadSchema.parse(
      owner.stagedCoordinatorProvenance,
    ),
    baseline = observation.source.baseline;
  if (
    owner.coordinatorPull ||
    owner.plan.coordinatorImage?.action !== "apply" ||
    owner.admissionDigest !== state.receiptDigest ||
    controlDigest(admitted) !== state.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution) ||
    canonicalJson(owner.origin) !== canonicalJson(state.origin) ||
    canonicalJson(observation.ownerPrepare) !== canonicalJson(state.execution) ||
    observation.candidateId !== owner.plan.operation.candidateId ||
    observation.planDigest !== owner.plan.planDigest ||
    baseline.configurationRevisionId !== owner.plan.operation.expectedCurrentRevisionId ||
    canonicalJson(owner.originalContainers.find((c) => c.serviceId === "data-manager")) !==
      canonicalJson(baseline.container)
  )
    throw Error("Original staged owner/source binding changed");
  let expectedCurrentRevisionId = baseline.configurationRevisionId;
  if (owner.receipt.generation === "committed") {
    const generation = owner.apiControls.steps.find((value) => value.ordinal === 0);
    if (
      !generation?.canonical ||
      owner.receipt.appliedRevisionId !== owner.plan.operation.revisionId
    )
      throw Error("Original staged owner generation required");
    const child = verifyConfigurationMaintenanceChildTerminal(
        authority,
        0,
        generation.canonical.status,
        generation.canonical.terminalAt,
      ),
      verified = configurationMaintenanceChildState(child, authority),
      lease = restoreArtifactTargetLeaseForSettlement(authority);
    try {
      const physical = inspectLocalLeaseChildSettlement(lease, generation.execution);
      if (!physical || canonicalJson(physical) !== canonicalJson(verified.settlement))
        throw Error("Actual staged generation settlement required");
    } finally {
      closeArtifactTargetLeaseHandle(lease);
    }
    expectedCurrentRevisionId = owner.plan.operation.revisionId;
  } else if (
    owner.receipt.generation !== "not_started" &&
    owner.receipt.generation !== "not_committed"
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
  const admitted = readPrivateRecord(
    state.installation,
    "executions",
    `${state.execution.operationKey}.json`,
    65536,
  ) as { operation?: { maintenanceId?: string } };
  const name = `${uuid.parse(admitted.operation?.maintenanceId)}.json`,
    raw = readPrivateRecord(state.installation, "configuration-maintenance", name);
  const owner = configurationMaintenanceOwnerRecordSchema.parse(raw);
  const witness = coordinatorPullWitnessPayloadSchema.parse(owner.coordinatorPull);
  if (
    owner.admissionDigest !== state.receiptDigest ||
    controlDigest(admitted) !== state.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution) ||
    canonicalJson(owner.origin) !== canonicalJson(state.origin) ||
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
        owner.receipt.generation === "committed"
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
    canonical = readTerminalCommitment(state),
    terminal = terminalIdentity(state, status),
    settlement = verifyControlEffectSettlement(installation, admitted.execution),
    effect = settlementSchema
      .extend({ receipt: effectObservationSchema })
      .parse(
        readPrivateRecord(state.installation, "effects", `${admitted.execution.operationKey}.json`),
      );
  if (
    canonical.phase !== "canonical" ||
    terminal.terminal.state !== "succeeded" ||
    canonical.terminalDigest !== terminal.digest ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    canonicalJson(terminal.terminal.result) !== canonicalJson(effect.receipt.result)
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
      terminalReceiptDigest: terminal.digest,
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
declare const maintenanceChildBrand: unique symbol;
export type VerifiedConfigurationMaintenanceChild = Readonly<{ [maintenanceChildBrand]: true }>;
const maintenanceChildren = new WeakMap<
  VerifiedConfigurationMaintenanceChild,
  {
    rootDigest: string;
    ordinal: number;
    execution: ExecutionRef;
    status: OpsJobStatus;
    terminalDigest: string;
    terminalAt: number;
    effectSettlementDigest: string;
    settlement: ChildSettlement;
  }
>();
/** The status is only a canonical preimage. The actual original admission,
 * fixed phase, private effect and private canonical tuple/time
 * must ALL agree; a public status/result/digest cannot create this proof. */
export function verifyConfigurationMaintenanceChildTerminal(
  authority: VerifiedExecutionAuthority,
  ordinal: number,
  input: OpsJobStatus,
  terminalAt: number,
): VerifiedConfigurationMaintenanceChild {
  const root = executionAuthorityState(authority);
  if (
    root.kind !== "configurationMaintenance.prepare" ||
    root.installation.installation.role !== "ops-agent" ||
    root.installation.fixedChildId
  )
    throw Error("Original maintenance child source required");
  const admitted = readPrivateRecord(
      root.installation,
      "executions",
      `${root.execution.operationKey}.json`,
      65536,
    ) as { operation?: { maintenanceId?: string } },
    name = `${uuid.parse(admitted.operation?.maintenanceId)}.json`,
    raw = readPrivateRecord(root.installation, "configuration-maintenance", name),
    owner = configurationMaintenanceOwnerRecordSchema.parse(raw);
  assertConfigurationMaintenanceDecisionSource(owner);
  const step = owner.plan.steps[ordinal],
    source = owner.apiControls.steps.find((value) => value.ordinal === ordinal),
    slot = root.reservations.find((value) => value.ordinal === ordinal),
    child = slot && lookupControlChildPhase(authority, slot);
  if (
    !step ||
    !source?.grant ||
    !child ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(root.execution) ||
    owner.admissionDigest !== root.receiptDigest ||
    canonicalJson(source.execution) !== canonicalJson(child.execution)
  )
    throw Error("Original frozen maintenance child required");
  const childAuthority = restoreAdmittedControlExecution(
      root.installation.installation,
      child.execution,
    ),
    state = executionAuthorityState(childAuthority),
    admission = readPrivateRecord(
      root.installation,
      "executions",
      `${child.execution.operationKey}.json`,
      65536,
    ) as { operation?: unknown; parent?: unknown },
    canonical = readTerminalCommitment(state),
    status = parseOpsJobStatus(input),
    settlement = childSettlementState(
      verifyControlEffectSettlement(root.installation.installation, child.execution),
    ).evidence,
    effect = settlementSchema
      .extend({ receipt: effectObservationSchema })
      .parse(
        readPrivateRecord(root.installation, "effects", `${child.execution.operationKey}.json`),
      );
  const nonCommit =
      step.phase === "configuration-commit" &&
      effect.receipt.kind === "configuration-generation-not-committed" &&
      settlement.outcome === "contained" &&
      settlement.publication === "not_started" &&
      canonicalJson(
        inspectConfigurationGenerationNonCommit(root.installation.installation, child.execution)
          .result,
      ) === canonicalJson(status.result),
    committed =
      settlement.outcome === "committed" &&
      settlement.publication === "committed" &&
      effect.receipt.kind === "ops-result" &&
      canonicalJson(parseBoundedOpsResult(step.operation.kind, effect.receipt.result)) ===
        canonicalJson(status.result);
  if (
    canonical.phase !== "canonical" ||
    canonical.terminalAt !== terminalAt ||
    canonical.terminalDigest !== controlTerminalReceiptDigest(status) ||
    status.state !== "succeeded" ||
    status.kind !== step.operation.kind ||
    status.operationId !== child.execution.executionId ||
    status.operationKey !== child.execution.operationKey ||
    status.fingerprint !== child.execution.fingerprint ||
    status.deadlineAt !== child.execution.deadlineAt ||
    canonicalJson(admission.operation) !== canonicalJson(step.operation) ||
    canonicalJson(admission.parent) !== canonicalJson(retainedControlParent(root.execution)) ||
    !(committed || nonCommit)
  )
    throw Error("Actual committed maintenance child canonical/effect source required");
  if (
    step.phase === "configuration-commit" &&
    !nonCommit &&
    (!(status.result && typeof status.result === "object") ||
      (status.result as { outcome?: string }).outcome !== "committed" ||
      (status.result as { revisionId?: string }).revisionId !== owner.plan.operation.revisionId)
  )
    throw Error("Original candidate generation commit required");
  const { diagnostics: _diagnostics, ...safe } = status,
    value = Object.freeze({}) as VerifiedConfigurationMaintenanceChild;
  const freezeSource = <T>(data: T): T => {
    if (data && typeof data === "object" && !Object.isFrozen(data)) {
      for (const child of Object.values(data)) freezeSource(child);
      Object.freeze(data);
    }
    return data;
  };
  maintenanceChildren.set(
    value,
    freezeSource({
      rootDigest: root.receiptDigest,
      ordinal,
      execution: child.execution,
      status: safe,
      terminalDigest: canonical.terminalDigest,
      terminalAt: canonical.terminalAt,
      effectSettlementDigest: controlDigest(settlement),
      settlement,
    }),
  );
  return value;
}
export function configurationMaintenanceChildState(
  value: VerifiedConfigurationMaintenanceChild,
  authority: VerifiedExecutionAuthority,
) {
  const source = maintenanceChildren.get(value),
    root = executionAuthorityState(authority);
  if (
    !source ||
    source.rootDigest !== root.receiptDigest ||
    root.kind !== "configurationMaintenance.prepare"
  )
    throw Error("Actual original maintenance child proof required");
  return source;
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

export const CONTROL_RECOVERY_INSTRUCTIONS =
  "Run openmapx compose render on the installation host to provision control trust. For missing or conflicting retained records: stop all relevant writers and helpers, inspect the original private receipts and publication state, and repair only the exact owned record; never delete locks by age.";
/** Availability is not authority. An unavailable signer leaves inspection/recovery HTTP routes intact. */
export function loadControlStartup(options: Parameters<typeof openControlInstallation>[0]): {
  installation?: ControlInstallation;
  reason?: string;
} {
  try {
    return { installation: openControlInstallation(options) };
  } catch {
    return { reason: CONTROL_RECOVERY_INSTRUCTIONS };
  }
}
export const controlAdoptionSchema = z.strictObject({
  leaseId: uuid,
  delegationId: uuid,
  phase: z.enum(["pending-adoption", "ready", "recovery_required"]),
});
export type ControlAdoption = z.infer<typeof controlAdoptionSchema>;

/** What a recipient in another role needs to know about the parent: it trusts
 * the parent's authenticated caller, never a file of the parent's role. */
const parentSummarySchema = z.strictObject({
  origin: controlOriginSchema,
  parent: executionRefSchema,
  child: executionRefSchema,
  kind: z.string().max(128),
  phase: z.enum(["data-workflow", "osm", "transit", "fonts", "data-step"]),
  ordinal: z.number().int().min(0).max(63),
});
const parentAssertionSchema = z.strictObject({
  version: z.literal(2),
  issuer: z.enum(CONTROL_ROLES),
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  attemptId: uuid,
  grantDigest: digest,
  grant: parentSummarySchema,
});
const parentGrantSchema = z.strictObject({
  version: z.literal(2),
  origin: controlOriginSchema,
  parent: executionRefSchema,
  child: executionRefSchema,
  kind: z.string().max(128),
  phase: z.enum(["data-workflow", "osm", "transit", "fonts", "data-step"]),
  recipient: z.enum(["fixed-cli", "data-manager"]),
  childId: z.string().max(256),
  attemptId: uuid,
  parentAssertion: z.string().max(4096).optional(),
  ordinal: z.number().int().min(0).max(63),
});
function parentSummary(grant: z.infer<typeof parentGrantSchema>) {
  return parentSummarySchema.parse({
    origin: grant.origin,
    parent: grant.parent,
    child: grant.child,
    kind: grant.kind,
    phase: grant.phase,
    ordinal: grant.ordinal,
  });
}
/** Whether the parent's records are in this role's own private state. */
function parentReadable(state: InstallationState, issuer: ControlIssuer): boolean {
  return (
    issuer === state.installation.role || (Boolean(state.fixedChildId) && issuer === "ops-agent")
  );
}
/**
 * The parent of a data-manager execution named by an agent or host CLI caller.
 * Data-manager cannot read the caller's records; it trusts the caller it
 * authenticated by token, and the parent cancels its children explicitly.
 */
export function verifiedRemoteParentExecution(
  installation: ControlInstallation,
  assertion: string,
  input: {
    transportPrincipal: ControlTransportPrincipal;
    operationKey: string;
    operationFingerprint: string;
    kind: string;
    requestedDeadlineAt?: number;
  },
): {
  parent: import("../ops/execution-identity").VerifiedParentExecution;
  execution: ExecutionRef;
} {
  const parsed = parseParentAssertion(assertion),
    grant = parsed.grant;
  if (
    installation.role !== "data-manager" ||
    parsed.issuer !== grant.parent.executor ||
    !(
      (input.transportPrincipal === "ops-agent" &&
        (grant.parent.executor === "ops-agent" || grant.parent.executor === "host-cli")) ||
      (input.transportPrincipal === "host-cli" && grant.parent.executor === "host-cli")
    ) ||
    grant.child.operationKey !== input.operationKey ||
    grant.child.operationFingerprint !== input.operationFingerprint ||
    grant.kind !== input.kind ||
    grant.child.deadlineAt !== input.requestedDeadlineAt ||
    grant.child.deadlineAt > grant.parent.deadlineAt ||
    grant.child.operationKey !==
      controlChildOperationKey(grant.parent.operationKey, grant.phase, grant.ordinal) ||
    !childPhaseKinds[grant.phase].includes(grant.kind)
  )
    throw Error("Parent child identity mismatch");
  const parent = Object.freeze(
    retainedControlParent(grant.parent),
  ) as import("../ops/execution-identity").VerifiedParentExecution;
  verifiedParents.add(parent);
  verifiedParentOrigins.set(parent, grant.origin);
  const local = installationState(installation),
    name = `${grant.child.operationKey}.json`;
  try {
    const saved = z
      .strictObject({ assertion: z.string() })
      .parse(readPrivateRecord(local, "execution-parents", name));
    if (saved.assertion !== assertion) throw Error("Parent attempt replay conflict");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writePrivateRecord(local, "execution-parents", name, { assertion }, true);
  }
  return { parent, execution: grant.child };
}
function parseParentAssertion(assertion: string) {
  if (assertion.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(assertion))
    throw Error("Invalid parent assertion");
  const parsed = parentAssertionSchema.parse(
    JSON.parse(Buffer.from(assertion, "base64url").toString("utf8")),
  );
  if (Buffer.from(canonicalJson(parsed)).toString("base64url") !== assertion)
    throw Error("Noncanonical parent assertion");
  return parsed;
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
const dataTerminalObservationSchema = z.strictObject({
  version: z.literal(2),
  execution: executionRefSchema,
  status: dataExecutionStatusSchema,
  observedAt: z.number().int().positive().safe(),
  terminalDigest: digest,
});
const dataTerminalName = (execution: ExecutionRef) =>
  `data-terminal-${execution.operationKey}.json`;
/**
 * Records the terminal status data-manager reported for a child this role
 * issued, read over data-manager's authenticated route. Only a terminal status
 * with a known publication is recorded, and a recorded status never changes.
 */
export function recordDataControlTerminalObservation(
  installation: ControlInstallation,
  execution: ExecutionRef,
  status: import("../services/data-manager/contracts/executions").DataExecutionStatus,
) {
  const local = installationState(installation),
    parsed = dataExecutionStatusSchema.parse(status);
  if (
    parsed.operationKey !== execution.operationKey ||
    parsed.fingerprint !== execution.fingerprint ||
    !["ok", "partial", "error", "canceled", "interrupted"].includes(parsed.status) ||
    parsed.publication === "unknown"
  )
    throw Error("Exact terminal data-manager status required");
  const terminalDigest = controlDigest({ version: 1, status: parsed });
  try {
    const prior = dataTerminalObservationSchema.parse(
      readPrivateRecord(local, "observations", dataTerminalName(execution)),
    );
    if (prior.terminalDigest !== terminalDigest) throw Error("Recorded data terminal changed");
    return prior;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const observation = dataTerminalObservationSchema.parse({
    version: 2,
    execution,
    status: parsed,
    observedAt: Date.now(),
    terminalDigest,
  });
  writePrivateRecord(local, "observations", dataTerminalName(execution), observation, true);
  return observation;
}
/** The terminal status this role recorded for its data-manager child. A dead
 * child process or an error alone is never containment evidence. */
export function readDataControlTerminalObservation(
  installation: ControlInstallation,
  execution: ExecutionRef,
  status?: import("../services/data-manager/contracts/executions").DataExecutionStatus,
) {
  const proof = dataTerminalObservationSchema.parse(
    readPrivateRecord(installationState(installation), "observations", dataTerminalName(execution)),
  );
  if (
    controlDigest(proof.execution) !== controlDigest(execution) ||
    (status &&
      canonicalJson(dataExecutionStatusSchema.parse(status)) !== canonicalJson(proof.status))
  )
    throw Error("Exact data-manager terminal observation required");
  return proof;
}
const opsTerminalObservationSchema = z.strictObject({
  version: z.literal(2),
  execution: executionRefSchema,
  status: z.unknown(),
  observedAt: z.number().int().positive().safe(),
  terminalDigest: digest,
});
const opsTerminalName = (execution: ExecutionRef) => `ops-terminal-${execution.operationKey}.json`;
/**
 * Records the terminal status the agent reported for a child this role issued,
 * read over the agent's authenticated route. A recorded status never changes.
 */
export function recordOpsControlTerminalObservation(
  installation: ControlInstallation,
  execution: ExecutionRef,
  input: OpsJobStatus,
): void {
  const local = installationState(installation),
    status = parseOpsJobStatus(input);
  if (
    status.operationId !== execution.executionId ||
    status.operationKey !== execution.operationKey ||
    status.fingerprint !== execution.fingerprint ||
    !["succeeded", "failed", "timed_out"].includes(status.state) ||
    // An outcome that still needs recovery is not known yet.
    status.errorClass === "recovery_required"
  )
    throw Error("Exact terminal agent status required");
  const terminalDigest = controlTerminalReceiptDigest(status);
  try {
    const prior = opsTerminalObservationSchema.parse(
      readPrivateRecord(local, "observations", opsTerminalName(execution)),
    );
    if (prior.terminalDigest !== terminalDigest) throw Error("Recorded agent terminal changed");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writePrivateRecord(
    local,
    "observations",
    opsTerminalName(execution),
    opsTerminalObservationSchema.parse({
      version: 2,
      execution,
      // Diagnostics are observational and excluded from the terminal digest.
      status: { ...status, diagnostics: { tail: [], truncated: false } },
      observedAt: Date.now(),
      terminalDigest,
    }),
    true,
  );
}
/** The terminal status this role recorded for its agent child. */
export function readOpsControlTerminalObservation(
  installation: ControlInstallation,
  execution: ExecutionRef,
): OpsJobStatus {
  const proof = opsTerminalObservationSchema.parse(
      readPrivateRecord(
        installationState(installation),
        "observations",
        opsTerminalName(execution),
      ),
    ),
    status = parseOpsJobStatus(proof.status);
  if (
    controlDigest(proof.execution) !== controlDigest(execution) ||
    controlTerminalReceiptDigest(status) !== proof.terminalDigest
  )
    throw Error("Exact agent terminal observation required");
  return status;
}
const lifecycleSchema = z.strictObject({
  version: z.literal(1),
  execution: executionRefSchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: z.enum(["held", "cancel_pending", "recovery_required", "settled"]),
  childIntents: z.record(uuid, digest),
  leaseIntents: z
    .record(
      uuid,
      z.strictObject({
        child: executionRefSchema,
        leaseId: uuid,
        grantDigest: digest,
        attemptDigest: digest,
      }),
    )
    .optional(),
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
function readLifecycle(
  state: InstallationState,
  dir: AnchoredDirectory,
  execution: ExecutionRef,
  verifier: string,
): ExecutionLifecycle {
  const raw = JSON.parse(
    dir.read(`${execution.operationKey}.lifecycle.json`, 65536).toString("utf8"),
  );
  const current = lifecycleSchema.parse(raw);
  if (
    controlDigest(current.execution) !== controlDigest(execution) ||
    Object.keys(current.childIntents).length + Object.keys(current.leaseIntents ?? {}).length > 64
  )
    throw Error("Execution lifecycle identity/capacity mismatch");
  const observationName = `${execution.executor}-${execution.operationKey}.json`;
  function compare(old: ExecutionLifecycle) {
    if (
      current.sequence < old.sequence ||
      (current.sequence === old.sequence && controlDigest(current) !== controlDigest(old))
    )
      throw Error("Execution lifecycle rollback or replacement");
  }
  if (verifier === controlIdentity(state.installation)) {
    const local = lifecycleSchema.parse(
      readPrivateRecord(state, "execution-lifecycle", `${execution.operationKey}.json`, 65536),
    );
    compare(local);
  }
  try {
    compare(
      lifecycleSchema.parse(
        readPrivateRecord(state, "lifecycle-observations", observationName, 65536),
      ),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  readControlExecutionWitness(state, execution);
  writePrivateRecord(state, "lifecycle-observations", observationName, current, false);
  return current;
}
function writeLifecycle(
  state: InstallationState,
  dir: AnchoredDirectory,
  lifecycle: ExecutionLifecycle,
  exclusive = false,
) {
  const bytes = canonicalJson(lifecycle);
  if (Buffer.byteLength(bytes) > 65536) throw Error("Execution lifecycle capacity");
  // Persist the private fence first. A crash before shared publication fails closed.
  writePrivateRecord(
    state,
    "execution-lifecycle",
    `${lifecycle.execution.operationKey}.json`,
    lifecycle,
    exclusive,
  );
  dir.write(`${lifecycle.execution.operationKey}.lifecycle.json`, bytes, exclusive);
  readLifecycle(state, dir, lifecycle.execution, controlIdentity(state.installation));
}
function initializeLifecycle(
  state: InstallationState,
  execution: ExecutionRef,
  newlyAdmitted: boolean,
) {
  withExecutionWriter(state, execution, (dir) => {
    try {
      readLifecycle(state, dir, execution, controlIdentity(state.installation));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (!newlyAdmitted)
        throw Error("Missing retained execution lifecycle requires supervised recovery");
      // Never replace a private fence after partial publication.
      try {
        readPrivateRecord(state, "execution-lifecycle", `${execution.operationKey}.json`);
        throw Error("Incomplete execution lifecycle requires supervised recovery");
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
      writeLifecycle(
        state,
        dir,
        {
          version: 1,
          execution,
          sequence: 0,
          phase: "held",
          childIntents: {},
        },
        true,
      );
    }
  });
}
function withParentLifecycles<T>(
  state: InstallationState,
  assertion: string,
  run: (forward: boolean) => T,
): T {
  const chain: Array<{
    assertion: string;
    grant: z.infer<typeof parentGrantSchema>;
    verifier: string;
  }> = [];
  function collect(value: string) {
    // A parent in another role cancels its children through their route.
    if (!parentReadable(state, parseParentAssertion(value).issuer)) return;
    const grant = readParentGrant(state, value);
    if (grant.parentAssertion) collect(grant.parentAssertion);
    const verifier = grant.parentAssertion
      ? readParentGrant(state, grant.parentAssertion).childId
      : grant.parent.executor;
    chain.push({ assertion: value, grant, verifier });
  }
  collect(assertion);
  function lock(index: number, forward: boolean): T {
    const item = chain[index];
    if (!item) return run(forward);
    return withExecutionWriter(state, item.grant.parent, (dir) => {
      const lifecycle = readLifecycle(state, dir, item.grant.parent, item.verifier);
      const parsed = parseParentAssertion(item.assertion);
      if (lifecycle.childIntents[parsed.attemptId] !== parsed.grantDigest)
        throw Error("Missing durable lifecycle child intent");
      return lock(
        index + 1,
        forward && lifecycle.phase === "held" && Date.now() < lifecycle.execution.deadlineAt,
      );
    });
  }
  return lock(0, true);
}
/** Narrow local runtime fence; exact duplicate admission alone never grants forward permission. */
export class ControlExecutionFencedError extends Error {}
export function markFeedProxyReloadAttempted(authority: VerifiedExecutionAuthority): void {
  withControlExecutionForward(authority, () => recordFeedProxyReloadAttempted(authority));
}
function withControlExecutionForward<T>(authority: VerifiedExecutionAuthority, run: () => T): T {
  const s = executionAuthorityState(authority);
  const check = () =>
    withExecutionWriter(s.installation, s.execution, (dir) => {
      const lifecycle = readLifecycle(
        s.installation,
        dir,
        s.execution,
        controlIdentity(s.installation.installation),
      );
      if (lifecycle.phase !== "held" || Date.now() >= s.execution.deadlineAt)
        throw new ControlExecutionFencedError(
          "Execution cannot restart effects; observation/settlement only; forward phase fenced",
        );
      return run();
    });
  const assertion = retainedParentAssertion(s);
  return assertion
    ? withParentLifecycles(s.installation, assertion, (forward) => {
        if (!forward)
          throw new ControlExecutionFencedError(
            "Canceled/terminal ancestor permits observation only",
          );
        return check();
      })
    : check();
}
/** Internal publication scope. All filesystem writes complete before guards
 * release; callers may not await HTTP/DB or acquire a lease from this scope. */
const publicationScopes = new WeakMap<VerifiedExecutionAuthority, AnchoredDirectory>();
/** Initial private owner publication precedes the first ordinary grant. */
export function withControlMaintenanceInitialization<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = executionAuthorityState(authority);
  if (
    s.kind !== "configurationMaintenance.prepare" ||
    s.installation.fixedChildId ||
    s.installation.installation.role !== "ops-agent"
  )
    throw Error("Original maintenance initialization required");
  return withControlExecutionForward(authority, run);
}
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
      const current = readLifecycle(
        s.installation,
        directory,
        s.execution,
        controlIdentity(s.installation.installation),
      );
      if (s.kind === "configurationMaintenance.prepare") {
        const admission = readPrivateRecord(
            s.installation,
            "executions",
            `${s.execution.operationKey}.json`,
            65536,
          ) as { operation?: { maintenanceId?: string } },
          raw = readPrivateRecord(
            s.installation,
            "configuration-maintenance",
            `${uuid.parse(admission.operation?.maintenanceId)}.json`,
          ),
          owner = configurationMaintenanceOwnerRecordSchema.parse(raw);
        if (
          owner.admissionDigest !== s.receiptDigest ||
          canonicalJson(owner.plan.prepare) !== canonicalJson(s.execution) ||
          canonicalJson(owner.origin) !== canonicalJson(s.origin) ||
          canonicalJson(owner.plan.reservations) !== canonicalJson(s.reservations)
        )
          throw Error("Original maintenance issuer changed");
        assertConfigurationMaintenanceDecisionSource(owner);
        if (
          [
            "configuration-commit",
            "maintenance-hardlinks",
            "maintenance-recreate",
            "maintenance-handoff",
          ].includes(phase) &&
          (canonicalJson(owner.receipt.prepare) !== canonicalJson(s.execution) ||
            !["authorized", "applying"].includes(owner.receipt.state) ||
            owner.receipt.decision?.decision !== "continue" ||
            owner.receipt.dmFence?.state !== "prepared" ||
            owner.apiControls.decide?.operation.decision !== "continue")
        )
          throw new ControlExecutionFencedError(
            "Original authorized configuration decision required",
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
  const assertion = retainedParentAssertion(s);
  return assertion
    ? withParentLifecycles(s.installation, assertion, (forward) => {
        if (!forward) throw Error("Canceled ancestor prevents grant publication");
        return own();
      })
    : own();
}
export function assertControlExecutionForward(authority: VerifiedExecutionAuthority): void {
  withControlExecutionForward(authority, () => {});
}
/** Only a prepared maintenance owner's finite metadata decision may use its
 * terminal preparation here. This scope issues no grant/forward handle and
 * does not alter ordinary execution normalization or terminal graph rules. */
export function withControlMaintenanceDecisionPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = executionAuthorityState(authority);
  if (s.kind !== "configurationMaintenance.prepare")
    throw Error("Original prepared maintenance decision owner required");
  const own = () =>
    withExecutionWriter(s.installation, s.execution, (directory) => {
      const current = readLifecycle(
        s.installation,
        directory,
        s.execution,
        controlIdentity(s.installation.installation),
      );
      if (current.phase !== "settled" || Date.now() >= s.execution.deadlineAt)
        throw new ControlExecutionFencedError(
          "Original prepared maintenance forward decision is fenced",
        );
      verifyControlPreparedTerminal(s.installation, s.execution);
      return run();
    });
  const assertion = retainedParentAssertion(s);
  return assertion
    ? withParentLifecycles(s.installation, assertion, (forward) => {
        if (!forward)
          throw new ControlExecutionFencedError("Canceled ancestor prevents maintenance continue");
        return own();
      })
    : own();
}
/** Only the protocol's frozen terminal preparation edges may outlive their local worker. */
export function assertControlDelegationForward(
  authority: VerifiedExecutionAuthority,
  phase: ControlChildPhase,
): void {
  withControlDelegationPublication(authority, phase, () => {});
}
function retainedParentAssertion(s: AuthorityState): string | undefined {
  if (s.installation.fixedParentAssertion) return s.installation.fixedParentAssertion;
  // Retain the exact adopted assertion with the execution, never search history.
  try {
    return z
      .object({ assertion: z.string() })
      .parse(
        readPrivateRecord(s.installation, "execution-parents", `${s.execution.operationKey}.json`),
      ).assertion;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return undefined;
}
/** Persist before a runtime publishes canceled state; return original attempted child identities for cancellation/lookup. */
export function cancelControlExecution(
  authority: VerifiedExecutionAuthority,
): readonly ExecutionRef[] {
  const s = executionAuthorityState(authority);
  return withExecutionWriter(s.installation, s.execution, (dir) => {
    const lifecycle = readLifecycle(
      s.installation,
      dir,
      s.execution,
      controlIdentity(s.installation.installation),
    );
    if (lifecycle.phase !== "settled" && lifecycle.phase !== "cancel_pending") {
      lifecycle.phase = "cancel_pending";
      lifecycle.sequence++;
      writeLifecycle(s.installation, dir, lifecycle);
    }
    const children = Object.keys(lifecycle.childIntents).map((id) => {
      const saved = z
        .object({ grant: z.unknown() })
        .parse(readPrivateRecord(s.installation, "parent-attempts", `${id}.json`));
      return Object.freeze(parentGrantSchema.parse(saved.grant).child);
    });
    for (const [id, intent] of Object.entries(lifecycle.leaseIntents ?? {})) {
      // The signed index is published before its private outbox. A crash in
      // that gap retains this exact identity for cancellation/lookup.
      let saved: unknown;
      try {
        saved = readPrivateRecord(s.installation, "parent-attempts", `${id}.json`, 8192);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (saved !== undefined && saved !== null) {
        const parsed = z
          .strictObject({ kind: z.literal("lease"), attempt: z.unknown() })
          .parse(saved);
        const value = leaseExecutionAttemptSchema.parse(parsed.attempt);
        if (
          controlDigest(value.origin) !== controlDigest(s.origin) ||
          controlDigest(value.parent) !== controlDigest(s.execution) ||
          controlDigest(parsed.attempt) !== intent.attemptDigest ||
          controlDigest(value.child) !== controlDigest(intent.child) ||
          value.leaseId !== intent.leaseId ||
          value.grantDigest !== intent.grantDigest
        )
          throw Error("Retained lease cancellation intent changed");
      }
      children.push(Object.freeze({ ...intent.child }));
    }
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
const leaseExecutionAttemptSchema = z.strictObject({
  version: z.literal(2),
  origin: controlOriginSchema,
  parent: executionRefSchema,
  child: executionRefSchema,
  leaseId: uuid,
  delegationId: uuid,
  grantDigest: digest,
});
/** Fixed lease issuer only; exact identities become cancellation-visible before
 * outbox/shared exposure, including a crash before the parent node update. */
export function recordLeaseControlAttempt(
  authority: VerifiedExecutionAuthority,
  input: { child: ExecutionRef; leaseId: string; delegationId: string; grantDigest: string },
): void {
  const s = executionAuthorityState(authority),
    directory = assertControlPublicationScope(authority);
  const lifecycle = readLifecycle(
    s.installation,
    directory,
    s.execution,
    controlIdentity(s.installation.installation),
  );
  const leases = lifecycle.leaseIntents ?? {};
  if (
    Object.keys(lifecycle.childIntents).length + Object.keys(leases).length >= 64 ||
    leases[input.delegationId]
  )
    throw Error("Execution cancellation intent capacity/replay");
  const attempt = leaseExecutionAttemptSchema.parse({
    version: 2,
    origin: s.origin,
    parent: s.execution,
    ...input,
  });
  leases[input.delegationId] = {
    child: input.child,
    leaseId: input.leaseId,
    grantDigest: input.grantDigest,
    attemptDigest: controlDigest(attempt),
  };
  lifecycle.leaseIntents = leases;
  lifecycle.sequence++;
  writeLifecycle(s.installation, directory, lifecycle);
  writePrivateRecord(
    s.installation,
    "parent-attempts",
    `${input.delegationId}.json`,
    { kind: "lease", attempt },
    true,
  );
}
export function settleExecutionLifecycle(s: AuthorityState) {
  withExecutionWriter(s.installation, s.execution, (dir) => {
    const lifecycle = readLifecycle(
      s.installation,
      dir,
      s.execution,
      controlIdentity(s.installation.installation),
    );
    if (lifecycle.phase !== "settled") {
      lifecycle.phase = "settled";
      lifecycle.sequence++;
      writeLifecycle(s.installation, dir, lifecycle);
    }
  });
}
export async function attestParentExecution(
  authority: VerifiedExecutionAuthority,
  child: {
    execution: ExecutionRef;
    phase: ControlChildPhase;
    serviceIds: readonly string[];
    recipient: ControlRecipient;
    childId: string;
  },
): Promise<string> {
  const s = executionAuthorityState(authority);
  if (Date.now() >= s.execution.deadlineAt) throw Error("Expired parent execution");
  const plan = resolveControlChildPlan(authority, child);
  if (!plan || !childPhaseKinds[child.phase].includes(plan.kind))
    throw Error("Child absent from retained plan");
  try {
    readPrivateRecord(s.installation, "execution-leases", `${s.execution.operationKey}.json`);
    throw Error("Deadline-only parent must not hold targets");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (
    child.recipient === "fixed-cli"
      ? child.phase !== "data-workflow" || s.installation.installation.role !== "ops-agent"
      : child.recipient !== "data-manager" ||
        !["osm", "transit", "fonts", "data-step"].includes(child.phase)
  )
    throw Error("Unauthorized deadline-only edge");
  if (["osm", "transit", "fonts"].includes(child.phase) && s.kind !== "data.update")
    throw Error("Only Full Update may delegate data phases");
  if (child.recipient === "data-manager" && child.childId !== "data-manager")
    throw Error("Wrong child role key");
  verifyDeadlineEdge(s.kind, child.phase, child.recipient, plan.kind);
  let attemptId: string = randomUUID();
  if (child.recipient === "fixed-cli") {
    attemptId = fixedControlChildId(s.installation, child.childId, s.execution);
  }
  const grant = parentGrantSchema.parse({
    version: 2,
    origin: s.origin,
    parent: s.execution,
    child: child.execution,
    kind: plan.kind,
    phase: child.phase,
    recipient: child.recipient,
    childId: child.childId,
    attemptId,
    ordinal: plan.ordinal,
    ...(s.installation.fixedParentAssertion
      ? { parentAssertion: s.installation.fixedParentAssertion }
      : {}),
  });
  const fields = {
    version: 2 as const,
    issuer: s.execution.executor,
    operationKey: s.execution.operationKey,
    attemptId,
    grantDigest: controlDigest(grant),
    grant: parentSummary(grant),
  };
  const assertion = Buffer.from(canonicalJson(parentAssertionSchema.parse(fields))).toString(
    "base64url",
  );
  parseParentAssertion(assertion);
  return withControlDelegationPublication(authority, child.phase, (dir) => {
    const lifecycle = readLifecycle(
      s.installation,
      dir,
      s.execution,
      controlIdentity(s.installation.installation),
    );
    if (lifecycle.phase !== "held" || Date.now() >= s.execution.deadlineAt)
      throw Error("Canceled/terminal execution cannot authorize forward children");
    const name = `${s.execution.operationKey}.children.json`;
    let witness: Record<string, unknown> = {};
    try {
      witness = z
        .record(uuid, z.unknown())
        .parse(JSON.parse(dir.read(name, 65536).toString("utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const value of Object.values(witness)) {
      const previous = parentGrantSchema.parse(value);
      if (previous.child.operationKey === child.execution.operationKey)
        throw Error("Attempted parent child cannot be replayed");
    }
    if (Object.keys(witness).length + Object.keys(lifecycle.leaseIntents ?? {}).length >= 64)
      throw Error("Parent attempt capacity");
    witness[attemptId] = grant;
    const bytes = canonicalJson(witness);
    if (Buffer.byteLength(bytes) > 65536) throw Error("Parent witness capacity");
    prepareControlChildPublication(authority, plan, {
      delegationId: attemptId,
      grantDigest: fields.grantDigest,
      leaseId: null,
    });
    writePrivateRecord(
      s.installation,
      "parent-attempts",
      `${attemptId}.json`,
      { grant: grant, assertion },
      true,
    );
    lifecycle.childIntents[attemptId] = fields.grantDigest;
    lifecycle.sequence++;
    writeLifecycle(s.installation, dir, lifecycle);
    dir.write(name, bytes);
    return assertion;
  });
}

export function readParentGrant(
  state: InstallationState,
  assertion: string,
  depth = 0,
): z.infer<typeof parentGrantSchema> {
  if (depth > 1) throw Error("Parent assertion chain limit");
  const parsed = parseParentAssertion(assertion);
  const d = executionWitnessDirectory(state, parsed.issuer);
  let signed: unknown;
  try {
    const attempts = z
      .record(uuid, z.unknown())
      .parse(
        JSON.parse(d.role.read(`${parsed.operationKey}.children.json`, 65536).toString("utf8")),
      );
    signed = attempts[parsed.attemptId];
  } finally {
    d.close();
  }
  if (!signed || controlDigest(signed) !== parsed.grantDigest)
    throw Error("Missing exact retained parent attempt");
  const grant = parentGrantSchema.parse(signed);
  if (grant.parentAssertion) {
    const ancestor = readParentGrant(state, grant.parentAssertion, depth + 1);
    if (
      ancestor.recipient !== "fixed-cli" ||
      controlDigest(ancestor.child) !== controlDigest(grant.parent) ||
      grant.recipient !== "data-manager"
    )
      throw Error("Invalid fixed parent certification");
  }
  const parent = readControlExecutionWitness(state, grant.parent);
  if (
    canonicalJson(parentSummary(grant)) !== canonicalJson(parsed.grant) ||
    !sameControlOrigin(grant.origin, parent.origin) ||
    grant.parent.executor !== parsed.issuer ||
    grant.parent.operationKey !== parsed.operationKey ||
    grant.attemptId !== parsed.attemptId ||
    grant.child.operationKey !==
      controlChildOperationKey(grant.parent.operationKey, grant.phase, grant.ordinal) ||
    !childPhaseKinds[grant.phase].includes(grant.kind)
  )
    throw Error("Parent immutable phase binding mismatch");
  verifyDeadlineEdge(parent.kind, grant.phase, grant.recipient, grant.kind);
  return grant;
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
export function verifyParentExecution(
  assertion: string,
  peer: VerifiedControlPeer,
  retainedAttempt: { execution: ExecutionRef; kind: string; requestedDeadlineAt: number },
): import("../ops/execution-identity").VerifiedParentExecution {
  const p = controlPeerState(peer);
  const parsed = parseParentAssertion(assertion);
  if (assertion !== p.assertion) throw Error("Foreign parent assertion");
  const grant = readParentGrant(p.installation, assertion);
  if (
    grant.parent.operationKey !== parsed.operationKey ||
    grant.attemptId !== parsed.attemptId ||
    grant.childId !== p.childId ||
    grant.recipient !== p.recipient ||
    grant.kind !== retainedAttempt.kind ||
    controlDigest(grant.child) !== controlDigest(retainedAttempt.execution) ||
    grant.child.deadlineAt !== retainedAttempt.requestedDeadlineAt ||
    grant.child.deadlineAt > grant.parent.deadlineAt
  )
    throw Error("Parent child identity mismatch");
  withParentLifecycles(p.installation, assertion, (forward) => {
    const name = `${parsed.attemptId}.json`;
    let retained = false;
    try {
      if (
        controlDigest(readPrivateRecord(p.installation, "parent-adoptions", name)) !==
        controlDigest(grant)
      )
        throw Error("Parent attempt replay conflict");
      retained = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (!retained) {
      if (!forward) throw Error("Canceled/terminal parent permits observation only");
      if (Date.now() >= grant.child.deadlineAt) throw Error("Expired parent grant");
      writePrivateRecord(
        p.installation,
        "execution-parents",
        `${grant.child.operationKey}.json`,
        { assertion },
        true,
      );
      writePrivateRecord(p.installation, "parent-adoptions", name, grant, true);
    }
    const binding = z
      .strictObject({ assertion: z.string() })
      .parse(
        readPrivateRecord(p.installation, "execution-parents", `${grant.child.operationKey}.json`),
      );
    if (binding.assertion !== assertion)
      throw Error("Incomplete/conflicting parent adoption binding");
  });
  const parent = Object.freeze(
    retainedControlParent(grant.parent),
  ) as import("../ops/execution-identity").VerifiedParentExecution;
  verifiedParents.add(parent);
  if (grant.origin) verifiedParentOrigins.set(parent, Object.freeze(grant.origin));
  return parent;
}

/** A fixed child shares the agent's private records and is known by its delegation or attempt id. */
export function openFixedChildInstallation(options: {
  infraDir: string;
  assertion: string;
}): ControlInstallation {
  const encoded = JSON.parse(Buffer.from(options.assertion, "base64url").toString("utf8")) as {
    leaseId?: unknown;
  };
  const envelope = encoded.leaseId
    ? parseControlAssertion(options.assertion)
    : parseParentAssertion(options.assertion);
  const id = "delegationId" in envelope ? envelope.delegationId : envelope.attemptId;
  let recovery: AnchoredDirectory | undefined;
  try {
    recovery = new AnchoredDirectory(
      controlPrivateRoot(options.infraDir, "ops-agent"),
      undefined,
      true,
    );
    const children = recovery.directory("children");
    try {
      children.read(`${id}.json`, 2048);
    } finally {
      children.close();
    }
    const installation = Object.freeze({ role: "ops-agent" }) as ControlInstallation;
    installations.set(installation, {
      installation,
      privateRoot: recovery,
      dataRoot: join(options.infraDir, "data"),
      registeredTargets: new Set(),
      // Fixed children run in the agent's container or its helper: both use the store.
      leases: agentStoreLeases(options.infraDir, "ops-agent"),
      fixedChildId: id,
      ...("attemptId" in envelope ? { fixedParentAssertion: options.assertion } : {}),
    });
    recovery = undefined;
    return installation;
  } finally {
    recovery?.close();
  }
}
export function retainFixedCliSpawnIntent(
  authority: VerifiedExecutionAuthority,
  input: {
    delegationId: string;
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
  const id = uuid.parse(input.delegationId);
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
    {
      execution: input.execution,
      operation,
      ...(input.dataUpdatePlan
        ? { dataUpdatePlan: dataUpdatePlanSchema.parse(input.dataUpdatePlan) }
        : {}),
      ...(input.dataWorkflowInitial
        ? { dataWorkflowInitial: dataWorkflowReceiptSchema.parse(input.dataWorkflowInitial) }
        : {}),
      args: input.args,
      serviceIds: plan.serviceIds,
      admittedAt: Date.now(),
      plan: z
        .array(plannedChildSchema)
        .max(64)
        .parse(input.plan ?? []),
      ...(input.reservations === undefined
        ? {}
        : {
            reservations: z.array(controlChildReservationSchema).max(64).parse(input.reservations),
          }),
    },
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
  const saved = z
    .strictObject({
      plan: z.array(plannedChildSchema).max(64),
      reservations: z.array(controlChildReservationSchema).max(64).optional(),
      execution: executionRefSchema,
      operation: opsOperationSchema,
      dataUpdatePlan: dataUpdatePlanSchema.optional(),
      dataWorkflowInitial: dataWorkflowReceiptSchema.optional(),
      args: z.array(z.string().max(4096)).max(64),
      serviceIds: targetSchema,
      admittedAt: z.number().int().nonnegative().safe(),
    })
    .parse(readPrivateRecord(s, "spawns", `${s.fixedChildId}.json`, 65536));
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
/** Fixed helper enrollment from the original indexed role-signed launch. A
 * caller target list cannot enroll a child, and the role key remains masked. */
export function readConfigurationHandoffSpawnIntent(
  installation: ControlInstallation,
  execution: ExecutionRef,
  handoffId: string,
) {
  const s = installationState(installation),
    name = configurationHandoffRecordName(handoffId, "intent"),
    raw = readPrivateRecord(s, "observations", name),
    saved = configurationHandoffIntentRecordSchema.parse(raw);
  if (
    !s.fixedChildId ||
    installation.role !== "ops-agent" ||
    s.fixedChildId !== saved.delegationId ||
    controlIdentity(installation) !== saved.helperId ||
    saved.operation.handoffId !== handoffId ||
    canonicalJson(saved.helper) !== canonicalJson(execution) ||
    execution.executor !== "host-cli" ||
    execution.operationFingerprint !==
      controlDigest({
        kind: "configuration-helper",
        handoffId,
        intentDigest: controlDigest(saved.operation),
      })
  )
    throw Error("Original configuration helper spawn required");
  s.registeredTargets = new Set(saved.operation.serviceIds);
  return saved;
}
export function beginFixedCliExecution(
  installation: ControlInstallation,
  execution: ExecutionRef,
): void {
  const s = installationState(installation);
  if (!s.fixedChildId) throw Error("Fixed CLI authority required");
  const begin = () =>
    writePrivateRecord(s, "spawn-started", `${s.fixedChildId}.json`, { execution }, true);
  if (s.fixedParentAssertion)
    withParentLifecycles(s, s.fixedParentAssertion, (forward) => {
      if (!forward) throw Error("Canceled/terminal parent prevents fixed CLI start");
      begin();
    });
  else begin();
}

/** Original agent-owned helper publication and its fixed-child committed
 * effect. Data only: no forward/adoption/lease authority is constructed. */
export function readCompletedConfigurationHandoff(
  installation: ControlInstallation,
  handoffId: string,
) {
  const state = installationState(installation);
  if (installation.role !== "ops-agent") throw Error("Original helper observer required");
  const intentName = configurationHandoffRecordName(handoffId, "intent"),
    intentRaw = readPrivateRecord(state, "observations", intentName),
    intent = configurationHandoffIntentRecordSchema.parse(intentRaw),
    progressName = configurationHandoffRecordName(handoffId, "progress"),
    progressRaw = readPrivateRecord(state, "observations", progressName),
    progress = configurationHandoffProgressSchema.parse(progressRaw),
    completionName = configurationHandoffRecordName(handoffId, "completion"),
    completionRaw = readPrivateRecord(state, "observations", completionName),
    completion = configurationHandoffWorkerRecordSchema.parse(completionRaw),
    effectName = `${intent.helper.operationKey}.json`,
    effectRaw = readPrivateRecord(state, "effects", effectName),
    effect = settlementSchema.extend({ receipt: effectObservationSchema }).parse(effectRaw);
  if (
    intent.operation.handoffId !== handoffId ||
    progress.intentDigest !== controlDigest(intent) ||
    progress.phase !== "launched" ||
    progress.launch.state !== "confirmed" ||
    completion.intentDigest !== controlDigest(intent) ||
    completion.preparationDigest !== controlDigest(progress) ||
    completion.phase !== "applied" ||
    !!intent.release !== !!completion.release ||
    (intent.release &&
      completion.release &&
      (completion.release.images.length !== intent.release.downloads.images.length ||
        completion.release.images.some(
          (image, index) =>
            image.image !== intent.release!.downloads.images[index]?.image ||
            image.reference !== intent.release!.downloads.images[index]?.reference ||
            image.phase !== "verified" ||
            !image.imageId,
        ))) ||
    completion.launch.containerId !== progress.launch.containerId ||
    canonicalJson(completion.execution) !== canonicalJson(intent.helper) ||
    canonicalJson(effect.identity) !== canonicalJson(intent.helper) ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "configuration-helper-completion" ||
    effect.receipt.completionDigest !== controlDigest(completion) ||
    effect.terminalReceiptDigest !== controlDigest(effect.receipt) ||
    completion.targets.length !== intent.operation.serviceIds.length ||
    completion.targets.some(
      (target) =>
        !intent.operation.serviceIds.includes(target.serviceId) ||
        target.expectedImageId !== intent.operation.expectedImageIdentities[target.serviceId] ||
        target.oldContainerId !==
          progress.targets.find((original) => original.serviceId === target.serviceId)
            ?.oldContainerId,
    )
  )
    throw Error("Original committed configuration helper required");
  const { receipt: _private, ...settlement } = effect;
  return { intent, completion, settlement };
}

const executionWitnessSchema = z.strictObject({
  version: z.literal(2),
  origin: controlOriginSchema,
  execution: executionRefSchema,
  kind: z.string().max(128),
  serviceIds: targetSchema,
  authorityDigest: digest,
});
export function readControlExecutionWitness(state: InstallationState, execution: ExecutionRef) {
  const d = executionWitnessDirectory(state, execution.executor);
  try {
    const witness = executionWitnessSchema.parse(
      JSON.parse(d.role.read(`${execution.operationKey}.json`, 65536).toString("utf8")),
    );
    if (controlDigest(witness.execution) !== controlDigest(execution))
      throw Error("Durable parent execution witness mismatch");
    return witness;
  } finally {
    d.close();
  }
}
function publishControlExecutionWitness(
  state: InstallationState,
  input: {
    execution: ExecutionRef;
    kind: string;
    serviceIds: readonly string[];
    origin: ControlExecutionOrigin;
  },
  authorityDigest: string,
) {
  const d = executionWitnessDirectory(state, input.execution.executor);
  try {
    const witness = {
      version: 2 as const,
      origin: input.origin,
      execution: input.execution,
      kind: input.kind,
      serviceIds: [...input.serviceIds],
      authorityDigest,
    };
    const name = `${input.execution.operationKey}.json`;
    try {
      const prior = JSON.parse(d.role.read(name, 65536).toString("utf8"));
      if (controlDigest(prior) !== controlDigest(witness))
        throw Error("Replaced execution witness");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      d.role.write(name, canonicalJson(witness), true);
    }
  } finally {
    d.close();
  }
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
export function retainedControlAdoptionAssertion(
  installation: ControlInstallation,
  adoption: ControlAdoption,
  execution: ExecutionRef,
): string {
  const state = installationState(installation);
  const saved = z
    .object({ assertion: z.string().max(4096), execution: executionRefSchema })
    .parse(readPrivateRecord(state, "adoptions", `${uuid.parse(adoption.delegationId)}.json`));
  const assertion = parseControlAssertion(saved.assertion);
  if (
    assertion.leaseId !== adoption.leaseId ||
    assertion.delegationId !== adoption.delegationId ||
    controlDigest(saved.execution) !== controlDigest(execution)
  )
    throw Error("Recovery adoption ownership mismatch");
  return saved.assertion;
}

const preparedTerminalSchema = z.strictObject({
  version: z.literal(1),
  execution: executionRefSchema,
  kind: z.enum(["configurationMaintenance.prepare", "configurationHandoff.prepare"]),
  receiptDigest: digest,
});
/** Fixed preparing adapter calls only after publishing its terminal journal. This performs the read itself. */
export function retainControlPreparedTerminal(authority: VerifiedExecutionAuthority): void {
  const s = executionAuthorityState(authority);
  if (
    s.installation.fixedChildId ||
    s.execution.executor !== "ops-agent" ||
    !["configurationMaintenance.prepare", "configurationHandoff.prepare"].includes(s.kind)
  )
    throw Error("Unsupported terminal preparation");
  const infra = new AnchoredDirectory(dirname(s.installation.dataRoot));
  let state: AnchoredDirectory | undefined;
  let jobs: AnchoredDirectory | undefined;
  try {
    state = infra.directory("state");
    jobs = state.directory("ops-agent");
    const journal = z
      .object({ version: z.literal(2), jobs: z.array(z.unknown()).max(256) })
      .parse(JSON.parse(jobs.read("jobs-v1.json", 24 * 1024 * 1024).toString("utf8")));
    const matches = journal.jobs.filter(
      (j) =>
        j &&
        typeof j === "object" &&
        (j as { operationId?: string }).operationId === s.execution.executionId,
    );
    if (matches.length !== 1) throw Error("Missing exact terminal preparation journal");
    const job = z
      .object({
        operationId: z.string(),
        operationKey: z.string(),
        operationFingerprint: digest,
        fingerprint: digest,
        deadlineAt: z.number().int().safe(),
        state: z.literal("succeeded"),
        operation: z.object({ kind: z.string() }).passthrough(),
        result: z
          .object({
            phase: z.literal("prepared").optional(),
            state: z.literal("prepared").optional(),
          })
          .passthrough(),
        terminalAt: z.iso.datetime(),
      })
      .parse(matches[0]);
    if (
      job.operationKey !== s.execution.operationKey ||
      job.operationFingerprint !== s.execution.operationFingerprint ||
      job.fingerprint !== s.execution.fingerprint ||
      job.deadlineAt !== s.execution.deadlineAt ||
      job.operation.kind !== s.kind ||
      controlDigest(job.operation) !== s.execution.operationFingerprint ||
      !(job.result.phase === "prepared" || job.result.state === "prepared")
    )
      throw Error("Terminal preparation identity mismatch");
    const record = preparedTerminalSchema.parse({
      version: 1,
      execution: s.execution,
      kind: s.kind,
      receiptDigest: controlDigest(job),
    });
    writePrivateRecord(
      s.installation,
      "prepared",
      `${s.execution.operationKey}.json`,
      record,
      true,
    );
    const d = executionWitnessDirectory(s.installation, "ops-agent");
    try {
      d.role.write(`${s.execution.operationKey}.prepared.json`, canonicalJson(record), true);
    } finally {
      d.close();
    }
  } finally {
    jobs?.close();
    state?.close();
    infra.close();
  }
}
export function verifyControlPreparedTerminal(
  state: InstallationState,
  execution: ExecutionRef,
): void {
  const d = executionWitnessDirectory(state, "ops-agent");
  try {
    const receipt = preparedTerminalSchema.parse(
      JSON.parse(d.role.read(`${execution.operationKey}.prepared.json`, 8192).toString("utf8")),
    );
    if (controlDigest(receipt.execution) !== controlDigest(execution))
      throw Error("Foreign terminal preparation");
  } finally {
    d.close();
  }
}

/** Target acquisition observes only its original data-phase owner and all three
 * signed, physically settled DM children. No progress object is authority. */
export async function verifyDataUpdatePrerequisites(authority: VerifiedExecutionAuthority) {
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
        assertion: attempt.assertion,
      });
      dataAuthority = restoreAdmittedControlExecution(childInstallation, attempt.execution);
      const settlement = childSettlementState(
        verifyControlEffectSettlement(childInstallation, attempt.execution),
      ).evidence;
      if (settlement.outcome !== "committed" || settlement.publication !== "committed")
        throw Error("Full Update data phase unsettled");
    }
    const dataState = executionAuthorityState(dataAuthority),
      receipt = readDataWorkflowProgress(dataAuthority);
    if (
      receipt.phase !== "build" ||
      receipt.children.length !== 3 ||
      receipt.children.some((c) => c.status !== "succeeded")
    )
      throw Error("Full Update data checkpoint missing");
    for (const [index, slot] of plan.dataChildren.entries()) {
      const bound = lookupControlChildPhase(dataAuthority, slot);
      if (!bound) throw Error("Full Update prerequisite missing");
      const child = receipt.children[index],
        witness = readDataControlTerminalObservation(
          dataState.installation.installation,
          bound.execution,
        );
      if (
        !child ||
        child.operationKey !== bound.execution.operationKey ||
        child.jobId !== bound.execution.executionId ||
        child.fingerprint !== bound.execution.fingerprint ||
        child.deadlineAt !== bound.execution.deadlineAt ||
        witness.status.status !== "ok" ||
        witness.status.publication !== "committed"
      )
        throw Error("Full Update prerequisite did not complete");
    }
    return receipt;
  } finally {
    if (childInstallation) closeControlInstallation(childInstallation);
  }
}

/** A signed progress file cannot mint success. Rejoin the actual original CLI
 * exit sources and DM settlements, and the exact generation they published. */
function verifyDataUpdateCompletionSource(
  authority: VerifiedExecutionAuthority,
  receipt: import("../ops/job-evidence").DataWorkflowReceipt,
) {
  const s = executionAuthorityState(authority);
  if (s.installation.fixedChildId) throw Error("Original Full Update root required");
  const name = `data-update-plan-${s.execution.operationKey}.json`,
    raw = readPrivateRecord(s.installation, "observations", name, 128 * 1024);
  const plan = dataUpdatePlanSchema.parse(raw),
    infraDir = dirname(s.installation.dataRoot);
  if (
    controlDigest(plan.parent) !== controlDigest(s.execution) ||
    opsOperationFingerprint(plan.operation) !== s.execution.operationFingerprint ||
    receipt.revisionId !== plan.finalRevisionId ||
    currentConfigurationGeneration(infraDir) !== plan.finalRevisionId ||
    dataUpdateSourcesDigest(infraDir) !== plan.sourcesDigest
  )
    throw Error("Original Full Update completion sources changed");
  const checkData = (dataAuthority: VerifiedExecutionAuthority) => {
    const dataState = executionAuthorityState(dataAuthority);
    for (const [index, slot] of plan.dataChildren.entries()) {
      const bound = lookupControlChildPhase(dataAuthority, slot),
        child = receipt.children[index];
      if (
        !bound ||
        !child ||
        child.operationKey !== bound.execution.operationKey ||
        child.jobId !== bound.execution.executionId ||
        child.fingerprint !== bound.execution.fingerprint ||
        child.deadlineAt !== bound.execution.deadlineAt ||
        readDataControlTerminalObservation(dataState.installation.installation, bound.execution)
          .status.status !== "ok"
      )
        throw Error("Actual Full Update data completion required");
    }
  };
  if (s.execution.executor === "ops-agent") {
    for (const slot of [plan.dataReservation, plan.finalizationReservation]) {
      const attempt = lookupControlChildPhaseAttempt(authority, slot);
      if (!attempt) throw Error("Full Update fixed phase missing");
      const child = openFixedChildInstallation({
        infraDir,
        assertion: attempt.assertion,
      });
      try {
        readFixedCliSpawnIntent(child, attempt.execution, fixedCliArguments(plan.operation));
        const childAuthority = restoreAdmittedControlExecution(child, attempt.execution),
          effect = childSettlementState(
            verifyControlEffectSettlement(child, attempt.execution),
          ).evidence;
        if (effect.outcome !== "committed" || effect.publication !== "committed")
          throw Error("Full Update fixed phase unsettled");
        const progress = readDataWorkflowProgress(childAuthority);
        if (slot.phase === "data-workflow") checkData(childAuthority);
        else if (canonicalJson(progress) !== canonicalJson(receipt))
          throw Error("Original Full Update final receipt changed");
      } finally {
        closeControlInstallation(child);
      }
    }
  } else {
    checkData(authority);
    for (const slot of plan.finalizationChildren) {
      const bound = lookupControlChildPhase(authority, slot);
      if (
        !bound ||
        readDataControlTerminalObservation(s.installation.installation, bound.execution).status
          .status !== "ok"
      )
        throw Error("Actual Full Update hardlink completion required");
    }
  }
}

/** Opaque local file version, never a public hash of a credential value. */
export function localFeedCredentialTemplateDigest(
  installation: ControlInstallation,
  operation: unknown,
  contents?: string,
) {
  return localCredentialTemplateFileDigest(installationState(installation), operation, contents);
}
