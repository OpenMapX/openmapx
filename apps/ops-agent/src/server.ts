import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  abandonUnstartedLease,
  acquireArtifactTargetLease,
  assertArtifactTargetLeaseExecution,
  assertArtifactTargetLeaseForward,
  assertControlStorageAvailable,
  assertFreshControlRoot,
  beginControlEffect,
  bindBorrowedControlExecution,
  buildArtifactSpec,
  CONTROL_PRUNE_AFTER_MS,
  type ControlInstallation,
  cancelArtifactTargetLease,
  cancelControlExecution,
  closeArtifactTargetLeaseHandle,
  commitFeedProxyValidationFailure,
  controlRegisteredServiceIds,
  inspectConfigurationPreEffectRefusal,
  inspectControlAdmission,
  inspectFeedProxyValidationFailure,
  isFixedSingleDataCommand,
  type LeaseStore,
  localLeaseBackend,
  markFeedProxyReloadAttempted,
  planFixedSingleDataCommand,
  controlHeaders as readControlHeaders,
  releaseArtifactTargetLease,
  replaceControlRegisteredServiceIds,
  reserveFeedProxyValidation,
  restoreAdmittedControlExecution,
  restoreArtifactTargetLeaseForSettlement,
  retainAdmittedControlExecution,
  retainConfigurationPreEffectRefusal,
  retainControlEffectReceipt,
  retainDataUpdatePlan,
  retainedControlAdoptionAssertion,
  retainFixedServiceLifecyclePlan,
  retainFixedSingleDataPlan,
  retainGenerationHardlinksOwnerPlan,
  settleArtifactTargetLeaseChild,
  startControlPrune,
  TargetBusyError,
  type TargetLeaseAuthority,
  type VerifiedExecutionAuthority,
  verifyControlEffectSettlement,
  verifyLocalArtifactTargetRootRelease,
  verifyRetainedArtifactTargetSettlement,
} from "@openmapx/core/build-artifacts";
import {
  inspectArtifactPublication,
  inspectSettledArtifactImport,
  retainUnstartedArtifactImport,
} from "@openmapx/core/build-artifacts/publication";
import {
  type ConfigurationApplyResult,
  canonicalJson,
  configurationApplyResultSchema,
  controlTerminalReceiptDigest,
  type ExecutionRef,
  executionFingerprint,
  isTrustedConfigurationApplyOperation,
  normalizeExecutionAdmission,
  OPS_KIND_POLICIES,
  OPS_MAX_CLOCK_SKEW_MS,
  OPS_MAX_EVENT_BATCH,
  OPS_MAX_EVENT_MESSAGE_BYTES,
  OPS_MAX_HTTP_RESPONSE_BYTES,
  OPS_MAX_REQUEST_TTL_MS,
  OPS_MAX_RESULT_BYTES,
  OPS_OPERATION_KINDS,
  OPS_PROTOCOL_VERSION,
  type OpsAdmission,
  OpsContractError,
  type OpsErrorClass,
  type OpsEventBatch,
  type OpsFailureResult,
  type OpsJobState,
  type OpsJobStatus,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResourcePolicy,
  type OpsRole,
  opsExecutionBudget,
  opsFailureResultSchema,
  opsKindRequiresControlAuthority,
  opsOperationFingerprint,
  opsResourceId,
  opsSuccess,
  PROCESS_OUTPUT_TRUNCATED,
  parseBoundedOpsResult,
  parseControlRootOperationKey,
  parseOpsRequest,
  processDiagnosticsSchema,
  redactedOpsError,
  signMaintenanceRecoveryProof,
  type VerifiedParentExecution,
  verifyApiJobParentExecution,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import Fastify, { type FastifyInstance } from "fastify";
import { inspectConfigurationGenerationNonCommit } from "../../../packages/core/src/build-artifacts/control-authority";
import { ArtifactTransferError } from "./artifact-transfer/errors";
import {
  finishRestoredPreparedImport,
  prepareArtifactImportAdmission,
  recoverPreparedImportFiles,
  retainArtifactImportPlan,
} from "./artifact-transfer/import-runtime";
import { registerArtifactTransferLifecycle } from "./artifact-transfer/lifecycle";
import { registerArtifactTransferRoutes } from "./artifact-transfer/routes";
import type { ArtifactTransferStore } from "./artifact-transfer/store";
import { readCommittedCatalogApproval } from "./catalog-approval-runtime";
import { configurationHandoffBlocksReplacement } from "./configuration-handoff";
import {
  assertPreparedConfigurationHandoff,
  assertRetainedConfigurationHandoffPreparation,
} from "./configuration-handoff-store";
import { prepareConfigurationHardlinksAdmission } from "./configuration-hardlinks-runtime";
import {
  configurationMaintenanceAdmissionState,
  prepareConfigurationMaintenanceAdmission,
  prepareMaintenanceContinueObservation,
} from "./configuration-maintenance-runtime";
import {
  admitConfigurationMaintenanceControlOwner,
  assertManagedCliConfigurationPreflight,
  ConfigurationMaintenanceControlConflict,
  ConfigurationMaintenanceControlUnauthorized,
  configurationHandoffPendingMaintenanceIds,
  configurationMaintenanceControlOwnerState,
  inspectConfigurationMaintenanceDecisionControl,
  inspectConfigurationMaintenanceSettleControl,
  inspectConfigurationMaintenanceSettleRecovery,
  normalizeConfigurationMaintenanceInspection,
  normalizeConfigurationMaintenanceRecoveryControl,
  prepareOwnedConfigurationMaintenanceStepAdmission,
  readOwnedConfigurationMaintenance,
  recordOwnedConfigurationMaintenanceStepTerminal,
  recoverUnadmittedConfigurationMaintenance,
  registerConfigurationMaintenanceJournal,
  restoreConfigurationMaintenanceControlJournal,
  retainConfigurationMaintenanceDecisionControl,
  retainConfigurationMaintenanceSettleControl,
  retainOwnedConfigurationMaintenance,
} from "./configuration-maintenance-store";
import { installCoordinatorStagedOwnershipSource } from "./coordinator-staged-ownership";
import { prepareDataUpdateAdmission, resolveDataDefaultRegion } from "./data-workflow-runtime";
import {
  type DawarichSubjectExportRouteOptions,
  registerDawarichSubjectExportRoute,
} from "./dawarich-subject-export";
import { isReportedProcessFailure } from "./docker-runtime";
import { registerOpsIngressRateLimit } from "./ingress-rate-limit";
import type { OpsJobJournal, PersistedOpsJob } from "./journal";
import { LeaseRefused, runLeaseOperation } from "./lease-operations";
import {
  type CoordinatorPullOwnershipObservation,
  consumeCoordinatorPullOwnershipCapture,
} from "./owned-services";
import { createPolicyResourceClaimer, type OpsResourceClaimer } from "./policy";
import { safeProcessDiagnostic } from "./process-output";
import { productionOwnedServices, productionRegisteredServiceIds } from "./production-runtime";
import {
  createUnavailableRuntime,
  dispatchOpsOperation,
  OpsAgentBusyError,
  type OpsExecutionContext,
  OpsExecutionFailure,
  OpsHostUpdateRequiredError,
  OpsNotWiredError,
  type OpsRuntime,
} from "./runtime";
import { prepareServiceUpdateAdmission } from "./service-lifecycle-runtime";
import { prepareCoordinatorPullBaseline } from "./service-pull-runtime";

const DEFAULT_BODY_LIMIT = 32 * 1024;
// A prepared candidate (up to 768 KiB) and its request envelope.
const CANDIDATE_BODY_LIMIT = 800 * 1024;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_REPLAY_ENTRIES = 10_000;
const DEFAULT_JOB_ENTRIES = 256;
const DEFAULT_JOB_RETENTION_MS = 60 * 60_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 15_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 5_000;
const MAX_JOB_ID_ATTEMPTS = 8;
const MAX_RETAINED_EVENTS_PER_JOB = 64;
const MAX_RETAINED_EVENT_BYTES_PER_JOB = 32 * 1024;
// New work and entries that need recovery have a bound each.
export const OPS_AGENT_RETENTION_LIMITS = {
  maxJobs: 2 * DEFAULT_JOB_ENTRIES,
  maxEventsPerJob: MAX_RETAINED_EVENTS_PER_JOB,
  maxEventBytesPerJob: MAX_RETAINED_EVENT_BYTES_PER_JOB,
  maxResultBytesPerJob: OPS_MAX_RESULT_BYTES,
  maxAggregateJournalBytes: 24 * 1024 * 1024,
  maxAggregateEventBytes: 2 * DEFAULT_JOB_ENTRIES * MAX_RETAINED_EVENT_BYTES_PER_JOB,
} as const;
// Conservative read-only surface while the release cache cannot be read safely.
/**
 * Operations that change containers claim their targets in the lease store
 * before any effect. Pulls, builds, execs and probes leave running containers
 * alone and claim nothing.
 */
const LEASED_KINDS = new Set<OpsOperationKind>([
  "configurationMaintenance.prepare",
  "artifactTransfer.import",
  "artifactTransfer.export",
  "stack.start",
  "stack.stop",
  "coreService.restart",
  "service.start",
  "service.stop",
  "service.restart",
  "service.remove",
  "service.recreate",
  "service.recreateIsolated",
  "service.update",
  "serviceRepository.remove",
  "backup.create",
  "backup.restore",
  "configuration.hardlinks.apply",
  "valhalla.traffic.maintain",
  "valhalla.traffic.refreshWaysToEdges",
]);
const RELEASE_RECOVERY_READ_KINDS = new Set<OpsOperationKind>([
  "configurationHandoff.inspect",
  "configurationMaintenance.inspect",
  "system.diagnostics",
  "docker.status",
  "stack.status",
  "services.inspect",
  "configuration.inspect",
  "configuration.hardlinks.inspect",
  "service.logs",
  "service.logs.follow",
  "dawarich.provisioning.inspect",
  "release.inspect",
  "backup.list",
  "system.inspect",
  "communityServices.inspect",
  "serviceSelection.inspect",
  "data.inspect",
  "valhalla.traffic.inspect",
  "postgis.capacity.inspect",
  "catalogPins.inspect",
  "transitCredentials.inspect",
  "transitousLock.inspect",
  "gbfsCatalogLock.inspect",
  // The API's recovery reads its prepared candidate while a handoff is pending.
  "configuration.candidate.read",
]);
const FALLBACK_REQUEST_ID = "ops1_unavailable000000";
const OPERATION_KIND_SET = new Set<string>(OPS_OPERATION_KINDS);
const REQUEST_ID_PATTERN = /^ops1_[A-Za-z0-9_-]{16,64}$/;
const OPERATION_ID_PATTERN = /^job1_[A-Za-z0-9_-]{16,64}$/;

export interface OpsAuditEvent {
  role: OpsRole;
  kind: OpsOperationKind | "invalid";
  resourceId: string;
  result: "success" | "denied" | "error" | "timeout" | "terminated" | "late_completion";
  durationMs: number;
  errorClass?: OpsErrorClass;
  /** The lease that refused a busy operation. */
  heldBy?: string;
}

export interface BuildOpsAgentServerOptions {
  artifactTransfers?: ArtifactTransferStore;
  controlInstallation?: ControlInstallation;
  /** The agent's lease store, for the leases data-manager and the host CLI hold. */
  leaseStore?: LeaseStore;
  tokens: Record<OpsRole, string>;
  releaseRecovery?: { ready: boolean; reason?: "recovery_required" };
  resourcePolicy?: OpsResourcePolicy;
  resourceClaimer?: OpsResourceClaimer;
  journal?: OpsJobJournal;
  runtime?: OpsRuntime;
  dispatch?: (
    operation: OpsOperation,
    runtime: OpsRuntime,
    context: OpsExecutionContext,
  ) => Promise<unknown>;
  audit?: (event: OpsAuditEvent) => void;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  bodyLimit?: number;
  operationTimeoutMs?: number;
  maxConcurrency?: number;
  maxReplayEntries?: number;
  maxJobEntries?: number;
  jobRetentionMs?: number;
  claimTimeoutMs?: number;
  /** Dedicated streaming managed-Dawarich collector; absent in minimal/dev agents. */
  dawarichExport?: Omit<DawarichSubjectExportRouteOptions, "apiToken">;
}

interface JobRecord extends Omit<PersistedOpsJob, "terminalAt"> {
  operation: OpsOperation;
  operationId: string;
  operationKey: string;
  fingerprint: string;
  resourceId: string;
  state: OpsJobState;
  submittedAt: string;
  updatedAt: string;
  result?: unknown;
  errorClass?: OpsErrorClass;
  terminalAt?: number;
  terminationRequestedAt?: string;
  cursor: number;
  events: OpsEventBatch["events"];
  eventBytes: number;
  eventsTruncated: boolean;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function resolveRole(
  authorization: string | undefined,
  tokens: Record<OpsRole, string>,
): OpsRole | null {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  const candidate = digest(match?.[1] ?? "");
  const apiMatches = timingSafeEqual(candidate, digest(tokens.api));
  const dataManagerMatches = timingSafeEqual(candidate, digest(tokens["data-manager"]));
  if (!match) return null;
  if (apiMatches) return "api";
  if (dataManagerMatches) return "data-manager";
  return null;
}

function validRequestId(value: unknown): string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : FALLBACK_REQUEST_ID;
}

/** Status reads speak only the current protocol; a missing or older header is refused. */
function supportedPeer(request: { headers: Record<string, unknown> }): boolean {
  return request.headers["x-ops-protocol-version"] === String(OPS_PROTOCOL_VERSION);
}

function requestIdFromBody(body: unknown): string {
  return validRequestId(
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { requestId?: unknown }).requestId
      : undefined,
  );
}

class RequestGuardError extends Error {
  constructor(
    readonly errorClass: OpsErrorClass,
    readonly statusCode: number,
    /** For a busy refusal by a target lease: the holder, as the reply names it. */
    readonly busyHolder?: string,
  ) {
    super(errorClass);
  }
}

/** A held target at the first admission attempt; the admission is tried again after a grace. */
class BusyAdmission extends Error {
  constructor(readonly target: string) {
    super("Target is busy");
  }
}

/** Waits until no lease holds `target`, or until `until`. */
async function waitForTargetRelease(
  store: LeaseStore,
  target: string,
  until: number,
  signal: AbortSignal,
): Promise<void> {
  while (Date.now() < until && store.list().some((lease) => lease.targets.includes(target))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    signal.throwIfAborted();
  }
}

class ReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries: number) {}

  accept(requestId: string, expiresAt: number, now: number): void {
    for (const [id, expiry] of this.entries) if (expiry <= now) this.entries.delete(id);
    if (this.entries.has(requestId)) throw new RequestGuardError("replay", 409);
    if (this.entries.size >= this.maxEntries) throw new RequestGuardError("busy", 429);
    this.entries.set(requestId, expiresAt);
  }
}

function validateTiming(
  issuedAt: string,
  expiresAt: string,
  nowMs: number,
): { expiresAtMs: number } {
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (issuedAtMs > nowMs + OPS_MAX_CLOCK_SKEW_MS) throw new RequestGuardError("future", 400);
  if (expiresAtMs <= nowMs) throw new RequestGuardError("stale", 400);
  const ttl = expiresAtMs - issuedAtMs;
  if (ttl <= 0 || ttl > OPS_MAX_REQUEST_TTL_MS) {
    throw new RequestGuardError("validation", 400);
  }
  return { expiresAtMs };
}

function operationKindFromBody(body: unknown): OpsOperationKind | "invalid" {
  const operation =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { operation?: unknown }).operation
      : undefined;
  const kind =
    operation && typeof operation === "object" && !Array.isArray(operation)
      ? (operation as { kind?: unknown }).kind
      : undefined;
  return typeof kind === "string" && OPERATION_KIND_SET.has(kind)
    ? (kind as OpsOperationKind)
    : "invalid";
}

function immutableSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  };
  freeze(snapshot);
  return snapshot;
}

function classify(error: unknown): { errorClass: OpsErrorClass; statusCode: number } {
  if (error instanceof ArtifactTransferError)
    return {
      errorClass:
        error.statusCode === 404
          ? "not_found"
          : error.statusCode === 503
            ? "runtime"
            : error.statusCode === 429
              ? "busy"
              : "conflict",
      statusCode: error.statusCode,
    };
  if (error instanceof OpsContractError) {
    return {
      errorClass: error.errorClass,
      statusCode: error.errorClass === "authorization" ? 403 : 400,
    };
  }
  if (error instanceof RequestGuardError) {
    return { errorClass: error.errorClass, statusCode: error.statusCode };
  }
  if (error instanceof OpsExecutionFailure)
    return {
      errorClass: error.errorClass,
      statusCode:
        error.errorClass === "timeout"
          ? 504
          : error.errorClass === "configuration_prerequisite"
            ? 409
            : 500,
    };
  if (error instanceof OpsHostUpdateRequiredError)
    return { errorClass: "host_update_required", statusCode: 409 };
  if (error instanceof OpsAgentBusyError) return { errorClass: "busy", statusCode: 409 };
  if (error instanceof OpsNotWiredError) return { errorClass: "not_wired", statusCode: 501 };
  return { errorClass: "runtime", statusCode: 500 };
}

export function buildOpsAgentServer(options: BuildOpsAgentServerOptions): FastifyInstance {
  if (new Set(Object.values(options.tokens)).size !== Object.keys(options.tokens).length) {
    throw new Error("Ops agent caller credentials must be distinct");
  }
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    requestTimeout: 0,
    connectionTimeout: DEFAULT_ADMISSION_TIMEOUT_MS,
  });
  registerOpsIngressRateLimit(app);
  app.addHook("onRequest", async (request, reply) => {
    const streaming =
      (request.routeOptions.config as { artifactTransferBytes?: boolean }).artifactTransferBytes ===
      true;
    // Fastify's injected transport has a minimal socket. Real connections keep
    // their idle timeout; admission also retains its independent destroy timer.
    request.raw.socket.setTimeout?.(streaming ? 5 * 60_000 : DEFAULT_ADMISSION_TIMEOUT_MS);
    if (streaming) return;
    const timer = setTimeout(() => request.raw.destroy(), DEFAULT_ADMISSION_TIMEOUT_MS);
    timer.unref?.();
    const clear = () => {
      clearTimeout(timer);
      request.raw.off("end", clear);
      request.raw.off("aborted", clear);
      reply.raw.off("close", clear);
    };
    request.raw.once("end", clear);
    request.raw.once("aborted", clear);
    reply.raw.once("close", clear);
  });
  if (options.dawarichExport) {
    registerDawarichSubjectExportRoute(app, {
      ...options.dawarichExport,
      apiToken: options.tokens.api,
    });
  }
  if (options.artifactTransfers) {
    registerArtifactTransferRoutes(app, {
      store: options.artifactTransfers,
      apiToken: options.tokens.api,
      admissionsOpen: () => configurationHandoffPendingMaintenanceIds(runtime).size === 0,
    });
  }
  const runtime = options.runtime ?? createUnavailableRuntime();
  const dispatch =
    options.dispatch ??
    ((operation, adapter, context) => dispatchOpsOperation(adapter, operation, context));
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const replay = new ReplayCache(options.maxReplayEntries ?? DEFAULT_REPLAY_ENTRIES);
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_CONCURRENCY;
  const maxJobEntries = Math.min(options.maxJobEntries ?? DEFAULT_JOB_ENTRIES, DEFAULT_JOB_ENTRIES);
  const jobRetentionMs = Math.max(
    options.jobRetentionMs ?? DEFAULT_JOB_RETENTION_MS,
    72 * 60 * 60_000,
  );
  const journal: OpsJobJournal =
    options.journal ??
    ({ records: () => [], replace: async () => undefined } satisfies OpsJobJournal);
  const unregisterMaintenanceJournal = registerConfigurationMaintenanceJournal(
    runtime,
    journal,
    options.controlInstallation,
  );
  app.addHook("onClose", async () => unregisterMaintenanceJournal());
  let literalProductionRuntime = false;
  try {
    productionOwnedServices(runtime);
    literalProductionRuntime = true;
  } catch {
    /* Generic runtimes retain cache-only ownership. */
  }
  if (literalProductionRuntime && options.controlInstallation && options.journal)
    installCoordinatorStagedOwnershipSource(runtime, options.controlInstallation, journal);
  const resourceClaimer =
    options.resourceClaimer ?? createPolicyResourceClaimer(options.resourcePolicy ?? {});
  const jobsById = new Map<string, JobRecord>();
  const jobsByKey = new Map<string, JobRecord>();
  const activeControllers = new Map<string, AbortController>();
  const activeSettlements = new Map<string, Promise<void>>();
  let stopControlPrune: (() => Promise<void>) | undefined;
  app.addHook("preClose", async () => {
    await stopControlPrune?.();
  });
  const stickyRecoveryRequired = new Set<string>();
  const configurationResultsSettling = new Set<string>();
  let active = 0;
  let admissionTail = Promise.resolve();
  let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  let diagnosticWriteActive = false;
  const dirtyDiagnostics = new Set<string>();

  const withAdmissionLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = admissionTail;
    let release!: () => void;
    admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const restoredRecords = journal.records();
  if (restoredRecords.length > 2 * maxJobEntries) {
    throw new Error("Ops job journal exceeds the configured server capacity");
  }
  for (const persisted of restoredRecords) {
    const restored: JobRecord = {
      ...persisted,
      terminalAt: persisted.terminalAt === undefined ? undefined : Date.parse(persisted.terminalAt),
      cursor: 0,
      events: [],
      eventBytes: 0,
      eventsTruncated: true,
    };
    jobsById.set(restored.operationId, restored);
    jobsByKey.set(`${restored.role}:${restored.operationKey}`, restored);
  }

  const audit = (
    role: OpsRole,
    kind: OpsOperationKind | "invalid",
    resourceId: string,
    result: OpsAuditEvent["result"],
    startedAt: number,
    errorClass?: OpsErrorClass,
  ) => {
    try {
      options.audit?.({
        role,
        kind,
        resourceId,
        result,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(errorClass ? { errorClass } : {}),
      });
    } catch {
      // Audit is deliberately best effort and cannot change protocol state.
    }
  };

  const controlLeases = new Map<string, TargetLeaseAuthority>();
  /** Jobs whose Docker command ended with a reported failure, so their outcome is known. */
  const reportedFailures = new Set<string>();
  const controlAuthorities = new Map<string, VerifiedExecutionAuthority>();
  const maintenanceControls = new Map<
    string,
    import("./configuration-maintenance-store").ConfigurationMaintenanceControlOwner
  >();
  app.addHook("onClose", async () => {
    for (const lease of controlLeases.values()) closeArtifactTargetLeaseHandle(lease);
    controlLeases.clear();
    controlAuthorities.clear();
    maintenanceControls.clear();
  });
  const persisted = (job: JobRecord): PersistedOpsJob => ({
    ...(job.controlAdoption ? { controlAdoption: job.controlAdoption } : {}),
    executionVersion: 2,
    requestVersion: job.requestVersion,
    admittedAt: job.admittedAt,
    deadlineAt: job.deadlineAt,
    operationFingerprint: job.operationFingerprint,
    requestedDeadlineAt: job.requestedDeadlineAt,
    deploymentBudgetMs: job.deploymentBudgetMs,
    parent: job.parent,
    ...(job.diagnostics ? { diagnostics: job.diagnostics } : {}),
    ...(job.failureResult ? { failureResult: job.failureResult } : {}),
    ...(job.progressResult ? { progressResult: job.progressResult } : {}),
    role: job.role,
    operation: job.operation,
    operationId: job.operationId,
    operationKey: job.operationKey,
    fingerprint: job.fingerprint,
    resourceId: job.resourceId,
    state: job.state,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.errorClass === undefined ? {} : { errorClass: job.errorClass }),
    ...(job.terminalAt === undefined ? {} : { terminalAt: new Date(job.terminalAt).toISOString() }),
    ...(job.terminationRequestedAt === undefined
      ? {}
      : { terminationRequestedAt: job.terminationRequestedAt }),
  });

  const flushDiagnostics = async () => {
    if (diagnosticWriteActive || dirtyDiagnostics.size === 0) return;
    diagnosticWriteActive = true;
    dirtyDiagnostics.clear();
    try {
      await withAdmissionLock(async () => journal.replace([...jobsById.values()].map(persisted)));
    } catch {
      /* Projection persistence failure never terminates owned backend work. */
    } finally {
      diagnosticWriteActive = false;
    }
  };
  const scheduleDiagnostics = (job: JobRecord) => {
    dirtyDiagnostics.add(job.operationId);
    if (diagnosticTimer !== undefined) return;
    diagnosticTimer = setTimeout(() => {
      diagnosticTimer = undefined;
      void flushDiagnostics();
    }, 1000);
    diagnosticTimer.unref?.();
  };
  app.addHook("onClose", async () => {
    if (diagnosticTimer !== undefined) clearTimeout(diagnosticTimer);
    await flushDiagnostics();
  });

  const recoveryRequired = (job: JobRecord) =>
    job.state === "failed" && job.errorClass === "recovery_required";
  /** The newest succeeded staged data-manager pull describes the running
   * coordinator; its journal entry and control records stay. */
  const newestStagedCoordinatorKey = () =>
    [...jobsById.values()]
      .filter(
        (job) =>
          job.role === "api" &&
          job.state === "succeeded" &&
          job.operation.kind === "service.pull" &&
          job.operation.serviceId === "data-manager" &&
          !!job.operation.candidateId,
      )
      .sort((a, b) => b.admittedAt - a.admittedAt)[0]?.operationKey;
  /** Control-authority entries stay until 72 hours after terminal and until
   * their timed root key has expired, so an API restarting in that window can
   * still read them. Other entries stay for the configured job retention. */
  const retainedJob = (job: JobRecord, nowMs: number) => {
    if (
      recoveryRequired(job) ||
      configurationResultsSettling.has(job.operationId) ||
      job.terminalAt === undefined ||
      job.operationKey === newestStagedCoordinatorKey()
    )
      return true;
    if (!options.controlInstallation || !opsKindRequiresControlAuthority(job.operation.kind))
      return job.terminalAt + jobRetentionMs > nowMs;
    let notAfter = 0;
    try {
      notAfter = parseControlRootOperationKey(job.operationKey).notAfter;
    } catch {
      /* A derived child key carries no expiry of its own. */
    }
    return job.terminalAt + CONTROL_PRUNE_AFTER_MS > nowMs || notAfter > nowMs;
  };
  const pruneJobs = async (nowMs: number) => {
    await withAdmissionLock(async () => {
      const retained = [...jobsById.values()].filter((job) => retainedJob(job, nowMs));
      if (retained.length === jobsById.size) return;
      await journal.replace(retained.map(persisted));
      for (const [id, job] of jobsById)
        if (!retainedJob(job, nowMs)) {
          jobsById.delete(id);
          jobsByKey.delete(`${job.role}:${job.operationKey}`);
        }
    });
  };
  /** A journal entry still describes this key's execution, directly or as the
   * preparation its maintenance controls belong to; its records stay. */
  const journalReferences = (operationKey: string) => {
    for (const job of jobsById.values())
      if (
        job.operationKey === operationKey ||
        ("prepareOperationKey" in job.operation &&
          job.operation.prepareOperationKey === operationKey)
      )
        return true;
    return false;
  };
  /** Records a maintenance step's terminal with its owner. False only when a
   * step's terminal could not be recorded. */
  const recordStepTerminal = (job: JobRecord): boolean => {
    if (
      !options.controlInstallation ||
      job.terminalAt === undefined ||
      !(
        isTrustedConfigurationApplyOperation(job.operation) ||
        job.operation.kind === "configuration.hardlinks.apply" ||
        job.operation.kind === "configurationHandoff.prepare" ||
        job.operation.kind === "service.recreate" ||
        job.operation.kind === "service.recreateIsolated"
      ) ||
      !job.operation.maintenanceId
    )
      return true;
    try {
      recordOwnedConfigurationMaintenanceStepTerminal(
        options.controlInstallation,
        job.operation,
        executionFor(job),
        statusFor(job),
        job.terminalAt,
      );
      return true;
    } catch {
      return false;
    }
  };
  /** Entries that need recovery are bounded separately, so they never use up
   * the capacity for new work. */
  const journalFull = (jobs: Iterable<JobRecord> = jobsById.values(), adding?: JobRecord) => {
    let recovery = 0,
      total = 0;
    for (const job of jobs) {
      total++;
      if (recoveryRequired(job)) recovery++;
    }
    if (adding)
      return recoveryRequired(adding)
        ? recovery >= maxJobEntries
        : total - recovery >= maxJobEntries;
    return total - recovery >= maxJobEntries || recovery >= maxJobEntries;
  };

  const truncateUtf8 = (message: string, maxBytes: number): string => {
    let bytes = 0;
    let bounded = "";
    for (const character of message) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > maxBytes) break;
      bounded += character;
      bytes += size;
    }
    return bounded;
  };

  const pushEvent = (job: JobRecord, event: OpsEventBatch["events"][number]) => {
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    while (
      job.events.length > 0 &&
      (job.events.length >= MAX_RETAINED_EVENTS_PER_JOB ||
        job.eventBytes + bytes > MAX_RETAINED_EVENT_BYTES_PER_JOB)
    ) {
      const removed = job.events.shift();
      if (removed) job.eventBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      job.eventsTruncated = true;
    }
    job.events.push(event);
    job.eventBytes += bytes;
  };

  const outwardStateFor = (job: JobRecord): OpsJobState =>
    configurationResultsSettling.has(job.operationId) ? "running" : job.state;

  const transition = async (
    job: JobRecord,
    state: OpsJobState,
    updates: Partial<
      Pick<
        JobRecord,
        "result" | "errorClass" | "terminalAt" | "terminationRequestedAt" | "failureResult"
      >
    > = {},
  ): Promise<void> => {
    await withAdmissionLock(async () => {
      if (state === "termination_pending" && job.terminalAt !== undefined) return;
      let updatedAt = now().toISOString();
      const maintenanceControl = maintenanceControls.get(job.operationId);
      if (
        maintenanceControl &&
        job.operation.kind === "configurationMaintenance.decide" &&
        ["succeeded", "failed", "timed_out"].includes(state)
      ) {
        const accepted = inspectConfigurationMaintenanceDecisionControl(
          maintenanceControl,
          job.operation,
          executionFor(job),
        );
        state = "succeeded";
        updatedAt = accepted.status.updatedAt;
        updates = {
          result: accepted.receipt,
          terminalAt: accepted.terminalAt,
          errorClass: undefined,
          failureResult: undefined,
          terminationRequestedAt: undefined,
        };
      }
      if (
        maintenanceControl &&
        job.operation.kind === "configurationMaintenance.settle" &&
        ["succeeded", "failed", "timed_out"].includes(state)
      ) {
        try {
          const accepted = inspectConfigurationMaintenanceSettleControl(
            maintenanceControl,
            job.operation,
            executionFor(job),
          );
          state = "succeeded";
          updatedAt = accepted.status.updatedAt;
          updates = {
            result: accepted.receipt,
            terminalAt: accepted.terminalAt,
            errorClass: undefined,
            failureResult: undefined,
            terminationRequestedAt: undefined,
          };
        } catch (error) {
          if (state === "succeeded") throw error;
          const unresolved = inspectConfigurationMaintenanceSettleRecovery(
            maintenanceControl,
            job.operation,
            executionFor(job),
          );
          state = "failed";
          updatedAt = unresolved.updatedAt;
          updates = {
            result: undefined,
            terminalAt: undefined,
            errorClass: "recovery_required",
            failureResult: undefined,
            terminationRequestedAt: undefined,
          };
        }
      }
      // A recorded terminal is final: the same outcome again changes nothing,
      // and only an outcome still needing recovery may be replaced by the one
      // recovery established.
      if (job.terminalAt !== undefined && !recoveryRequired(job)) {
        if (
          state === job.state &&
          canonicalJson(updates.result ?? null) === canonicalJson(job.result ?? null) &&
          (updates.errorClass ?? null) === (job.errorClass ?? null)
        )
          return;
        throw Error("Recorded terminal state is final");
      }
      const lease = controlLeases.get(job.operationId);
      const authority = controlAuthorities.get(job.operationId);
      if (
        authority &&
        lease &&
        job.operation.kind === "transitousLock.approve" &&
        ["succeeded", "failed", "timed_out"].includes(state)
      ) {
        const published = await readCommittedCatalogApproval(
          runtime,
          authority,
          lease,
          job.operation,
        );
        if (published) {
          state = "succeeded";
          updatedAt = new Date(published.terminalAt).toISOString();
          updates = {
            ...updates,
            result: published.result,
            terminalAt: published.terminalAt,
            errorClass: undefined,
            failureResult: undefined,
          };
        }
      }
      let releaseUnstartedRoot = false;
      let containedValidation: import("@openmapx/core/ops").TransferStage | undefined;
      if (authority && state === "termination_pending") cancelControlExecution(authority);
      if (lease && state === "termination_pending") await cancelArtifactTargetLease(lease);
      if (authority && ["succeeded", "failed", "timed_out"].includes(state)) {
        if (!options.controlInstallation) throw Error("Missing control settlement installation");
        // The fixed runtime's validated result is own-effect evidence. Failure alone is not containment.
        const committed = state === "succeeded" && updates.result !== undefined;
        const preparedMaintenance =
          committed && job.operation.kind === "configurationMaintenance.prepare";
        const preparedHandoff = committed && job.operation.kind === "configurationHandoff.prepare";
        if (preparedHandoff) assertPreparedConfigurationHandoff(authority, updates.result);
        if (
          preparedMaintenance &&
          canonicalJson(readOwnedConfigurationMaintenance(authority).receipt) !==
            canonicalJson(updates.result)
        )
          throw Error("Actual original prepared owner receipt required");
        let validationFailure: string | null = null;
        if (state === "failed" && job.operation.kind === "feedProxy.validateAndReload") {
          try {
            validationFailure = inspectFeedProxyValidationFailure(authority);
          } catch {
            /* Missing/corrupt producer evidence stays unknown. */
          }
        }
        let originalGenerationNonCommit = false;
        let unstartedConfiguration = false;
        if (
          state === "failed" &&
          job.operation.kind === "artifactTransfer.validate" &&
          options.artifactTransfers
        ) {
          try {
            containedValidation =
              await options.artifactTransfers.containPreparedValidation(authority);
            retainControlEffectReceipt(authority, {
              outcome: "committed",
              publication: "committed",
              receipt: { kind: "ops-result", result: containedValidation },
            });
          } catch {
            containedValidation = undefined; /* Uncontained extraction remains unknown. */
          }
        }
        let unstartedArtifact = false;
        if (state === "failed" && job.operation.kind === "artifactTransfer.import") {
          try {
            retainUnstartedArtifactImport(authority);
            unstartedArtifact = true;
          } catch {
            /* Attempted publication remains fenced. */
          }
        }
        if (state === "failed") {
          try {
            inspectConfigurationPreEffectRefusal(authority);
            unstartedConfiguration = true;
          } catch {
            /* Only the actual fixed pre-effect source qualifies. */
          }
        }
        if (
          state === "succeeded" &&
          isTrustedConfigurationApplyOperation(job.operation) &&
          updates.result &&
          (updates.result as { outcome?: string }).outcome === "not_committed"
        ) {
          const actual = inspectConfigurationGenerationNonCommit(
            options.controlInstallation,
            authority.execution,
          );
          if (canonicalJson(actual.result) !== canonicalJson(updates.result))
            throw Error("Original writer noncommit result changed");
          originalGenerationNonCommit = true;
        }
        const artifactNonCommit =
          committed &&
          job.operation.kind === "artifactTransfer.import" &&
          (updates.result as { outcome?: string })?.outcome === "not_committed";
        // A command that failed by its own report releases its targets with a
        // failed result; a crash, timeout or lost daemon stays unknown.
        const reportedFailure = state === "failed" && reportedFailures.delete(job.operationId);
        if (
          !originalGenerationNonCommit &&
          !unstartedConfiguration &&
          !unstartedArtifact &&
          !containedValidation
        )
          retainControlEffectReceipt(authority, {
            outcome: artifactNonCommit
              ? "contained"
              : committed
                ? "committed"
                : validationFailure || reportedFailure
                  ? "contained"
                  : "unknown",
            publication: artifactNonCommit
              ? "not_started"
              : committed || reportedFailure
                ? "committed"
                : validationFailure
                  ? "not_started"
                  : "unknown",
            receipt: committed
              ? { kind: "ops-result", result: updates.result }
              : validationFailure
                ? { kind: "feed-proxy-validation-failure", commitmentDigest: validationFailure }
                : reportedFailure
                  ? { kind: "reported-failure" }
                  : { kind: "unresolved" },
          });
        if (lease && job.operation.kind === "configurationMaintenance.prepare" && !committed) {
          try {
            // Only the complete disjoint source gate permits a failed prepare
            // to complete/release. Prepared or ambiguous guards stay fenced.
            await settleArtifactTargetLeaseChild(
              lease,
              verifyControlEffectSettlement(options.controlInstallation, authority.execution),
            );
            if (lease.mode === "owner") {
              await releaseArtifactTargetLease(lease);
              verifyLocalArtifactTargetRootRelease(authority);
              // Classify only this freshly proved, fully released never-prepared
              // refusal before the immutable terminal is first committed.
              // An unknown/partial release never takes this branch.
              if (state === "failed" && updates.errorClass === "recovery_required")
                updates = { ...updates, errorClass: "busy" };
            }
          } catch {
            /* Original retained owner/recovery path remains mandatory. */
          }
        } else if (
          lease &&
          job.operation.kind !== "configurationMaintenance.prepare" &&
          !preparedHandoff
        ) {
          await settleArtifactTargetLeaseChild(
            lease,
            verifyControlEffectSettlement(options.controlInstallation, authority.execution),
          );
          if (lease.mode === "owner" && (committed || reportedFailure)) {
            await releaseArtifactTargetLease(lease);
            if (job.operation.kind === "artifactTransfer.import") {
              try {
                await options.artifactTransfers?.reconcileReleasedPreparedImport(authority);
              } catch {
                /* Keep unexplained purpose state pinned. */
              }
            }
          }
          if (lease.mode === "owner" && (unstartedConfiguration || unstartedArtifact))
            releaseUnstartedRoot = true;
        }
      }
      if (["failed", "timed_out"].includes(state) && job.progressResult)
        updates = {
          ...updates,
          failureResult: opsFailureResultSchema.parse({
            ...job.progressResult,
            ...updates.failureResult,
          }),
        };
      if (releaseUnstartedRoot && job.operation.kind === "artifactTransfer.import") {
        state = "succeeded";
        updates = {
          ...updates,
          result: { outcome: "not_committed", reason: "failed", cleanupFailed: false },
          errorClass: undefined,
          failureResult: undefined,
        };
      }
      const candidate: JobRecord = { ...job, ...updates, state, updatedAt };
      if (["succeeded", "failed", "timed_out"].includes(state)) delete candidate.progressResult;
      if (state === "succeeded" && job.operation.kind === "services.buildAll")
        delete candidate.failureResult;
      if (releaseUnstartedRoot && lease?.mode === "owner" && authority) {
        await releaseArtifactTargetLease(lease);
        verifyLocalArtifactTargetRootRelease(authority);
        if (job.operation.kind === "artifactTransfer.import")
          await options.artifactTransfers?.reconcileReleasedPreparedImport(authority);
      }
      await journal.replace(
        [...jobsById.values()].map((entry) => persisted(entry === job ? candidate : entry)),
      );
      Object.assign(job, updates);
      if (["succeeded", "failed", "timed_out"].includes(state)) delete job.progressResult;
      if (state === "succeeded" && job.operation.kind === "services.buildAll")
        delete job.failureResult;
      job.updatedAt = updatedAt;
      job.state = state;
      if (lease && ["succeeded", "failed", "timed_out"].includes(state)) {
        closeArtifactTargetLeaseHandle(lease);
        controlLeases.delete(job.operationId);
      }
      job.cursor += 1;
      pushEvent(job, {
        cursor: job.cursor,
        type: "state",
        state: outwardStateFor(job),
      });
    });
  };

  const forceRecoveryRequired = (job: JobRecord): void => {
    stickyRecoveryRequired.add(job.operationId);
    const workerActive = activeControllers.has(job.operationId);
    job.result = undefined;
    job.errorClass = workerActive ? undefined : "recovery_required";
    job.terminalAt = workerActive ? undefined : now().getTime();
    job.updatedAt = now().toISOString();
    job.state = workerActive ? "termination_pending" : "failed";
    job.cursor += 1;
    pushEvent(job, { cursor: job.cursor, type: "state", state: job.state });
  };

  const identityFor = (job: JobRecord) => ({
    admittedAt: job.admittedAt,
    deadlineAt: job.deadlineAt,
    fingerprint: job.fingerprint,
  });
  const executionFor = (job: JobRecord): ExecutionRef =>
    Object.freeze({
      executor: "ops-agent",
      principal: job.role,
      executionId: job.operationId,
      operationKey: job.operationKey,
      operationFingerprint: job.operationFingerprint,
      fingerprint: job.fingerprint,
      deadlineAt: job.deadlineAt,
    });
  /** The secondary UNKNOWN projection may be repaired only from the actual
   * original owner's completed canonical source, never a runtime retry. */
  const refreshOriginalMaintenanceControl = async (job: JobRecord): Promise<void> => {
    if (
      job.operation.kind !== "configurationMaintenance.settle" ||
      job.errorClass !== "recovery_required" ||
      job.terminalAt !== undefined
    )
      return;
    const control = maintenanceControls.get(job.operationId);
    if (!control) return;
    try {
      inspectConfigurationMaintenanceSettleControl(control, job.operation, executionFor(job));
    } catch {
      return;
    }
    await transition(job, "succeeded");
  };
  function borrowedLeaseFor(id: string) {
    const lease = controlLeases.get(id);
    return lease?.mode === "borrowed" ? lease : undefined;
  }
  function ownedLeaseFor(id: string) {
    const lease = controlLeases.get(id);
    return lease?.mode === "owner" ? lease : undefined;
  }
  const contextFor = (
    job: JobRecord,
    signal: AbortSignal,
    claim: OpsExecutionContext["claim"],
  ): OpsExecutionContext => ({
    signal,
    claim,
    execution: executionFor(job),
    artifactLease: borrowedLeaseFor(job.operationId),
    ownedTargetLease: ownedLeaseFor(job.operationId),
    controlAuthority: controlAuthorities.get(job.operationId),
    ...(job.operation.kind === "data.update"
      ? {
          ownDataFinalizationLease(
            lease: import("@openmapx/core/build-artifacts").ArtifactTargetLease,
          ) {
            if (controlLeases.has(job.operationId))
              throw Error("Original Full Update lease already retained");
            assertArtifactTargetLeaseExecution(lease, executionFor(job));
            controlLeases.set(job.operationId, lease);
          },
          async checkpointDataWorkflow(
            dataWorkflow: import("@openmapx/core/ops").DataWorkflowReceipt,
          ) {
            const evidence = opsFailureResultSchema.parse({ ...job.progressResult, dataWorkflow });
            await withAdmissionLock(async () => {
              job.progressResult = evidence;
              job.updatedAt = now().toISOString();
              await journal.replace([...jobsById.values()].map(persisted));
            });
          },
        }
      : {}),
    ...(maintenanceControls.has(job.operationId)
      ? { configurationMaintenanceControl: maintenanceControls.get(job.operationId) }
      : {}),
    ...(job.operation.kind === "feedProxy.validateAndReload"
      ? {
          async commitFeedProxyValidationFailure(input: {
            candidateDigest: string;
            validationExitCode: number;
            completionDigest: string;
          }) {
            const authority = controlAuthorities.get(job.operationId);
            if (!authority) throw Error("Original validation authority missing");
            commitFeedProxyValidationFailure(authority, input);
          },
          async markFeedProxyReloadAttempted() {
            const authority = controlAuthorities.get(job.operationId);
            if (!authority) throw Error("Original validation authority missing");
            markFeedProxyReloadAttempted(authority);
          },
        }
      : {}),
    otherActiveOperations: () =>
      [...jobsById.values()].filter(
        (other) =>
          other.operationId !== job.operationId &&
          configurationHandoffBlocksReplacement(other.operation.kind, other.state),
      ).length + (options.artifactTransfers?.activeStreams ?? 0),
    ...(job.operation.kind === "services.buildAll"
      ? {
          checkpointServiceBatch: async (
            serviceBatch: import("@openmapx/core/ops").ServiceBatchResult,
          ) => {
            const evidence = opsFailureResultSchema.parse({ ...job.progressResult, serviceBatch });
            if (
              Buffer.byteLength(JSON.stringify(evidence)) >
              OPS_KIND_POLICIES[job.operation.kind].maxResultBytes
            )
              throw Error("Service batch evidence exceeds budget");
            await withAdmissionLock(async () => {
              job.progressResult = evidence;
              job.updatedAt = now().toISOString();
              await journal.replace([...jobsById.values()].map(persisted));
            });
          },
        }
      : {}),
    emitLog: (stream, message) => {
      const boundedMessage = truncateUtf8(
        safeProcessDiagnostic(message),
        OPS_MAX_EVENT_MESSAGE_BYTES,
      );
      const tail = [
        ...(job.diagnostics?.tail ?? []).filter(
          (entry) => entry.message !== PROCESS_OUTPUT_TRUNCATED,
        ),
        { stream, message: boundedMessage },
      ];
      let truncated =
        (job.diagnostics?.truncated ?? false) || boundedMessage === PROCESS_OUTPUT_TRUNCATED;
      while (
        tail.length > 255 ||
        Buffer.byteLength(JSON.stringify({ tail, truncated })) > 16 * 1024 - 128
      ) {
        const stdoutBytes = tail
          .filter((entry) => entry.stream === "stdout")
          .reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0);
        const stderrBytes = tail
          .filter((entry) => entry.stream === "stderr")
          .reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0);
        tail.splice(
          tail.findIndex(
            (entry) => entry.stream === (stdoutBytes >= stderrBytes ? "stdout" : "stderr"),
          ),
          1,
        );
        truncated = true;
      }
      job.diagnostics = {
        tail: [
          ...(truncated ? [{ stream: "stderr" as const, message: PROCESS_OUTPUT_TRUNCATED }] : []),
          ...tail,
        ],
        truncated,
      };
      scheduleDiagnostics(job);
      job.cursor += 1;
      pushEvent(job, {
        cursor: job.cursor,
        type: "log",
        stream,
        message: boundedMessage,
      });
    },
  });

  const admissionFor = (job: JobRecord): OpsAdmission => ({
    version: OPS_PROTOCOL_VERSION,
    execution: "async",
    operationId: job.operationId,
    operationKey: job.operationKey,
    kind: job.operation.kind,
    state: outwardStateFor(job),
    ...identityFor(job),
  });
  const statusFor = (job: JobRecord, internalTerminal = false): OpsJobStatus => ({
    version: OPS_PROTOCOL_VERSION,
    ...identityFor(job),
    ...(job.diagnostics ? { diagnostics: job.diagnostics } : {}),
    ...(job.failureResult ? { failureResult: job.failureResult } : {}),
    operationId: job.operationId,
    operationKey: job.operationKey,
    kind: job.operation.kind,
    resourceId: job.resourceId,
    state: internalTerminal ? job.state : outwardStateFor(job),
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    ...(job.terminationRequestedAt === undefined
      ? {}
      : { terminationRequestedAt: job.terminationRequestedAt }),
    ...(job.result === undefined ||
    (!internalTerminal && configurationResultsSettling.has(job.operationId))
      ? {}
      : { result: job.result }),
    ...(job.errorClass === undefined ||
    (!internalTerminal && configurationResultsSettling.has(job.operationId))
      ? {}
      : { errorClass: job.errorClass }),
  });

  const runAsync = async (
    job: JobRecord,
    startedAt: number,
    claim: OpsExecutionContext["claim"],
  ) => {
    try {
      await transition(job, "running");
    } catch {
      forceRecoveryRequired(job);
      audit(job.role, job.operation.kind, job.resourceId, "error", startedAt, "runtime");
      active -= 1;
      throw new RequestGuardError("runtime", 500);
    }
    const controller = new AbortController();
    activeControllers.set(job.operationId, controller);
    const timeoutMs = Math.max(0, (job.deadlineAt ?? now().getTime()) - now().getTime());
    let timedOut = false;
    let terminalDurable = false;
    let configurationEvidence: ConfigurationApplyResult | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      void transition(job, "termination_pending", {
        terminationRequestedAt: job.terminationRequestedAt ?? now().toISOString(),
      }).then(
        () => controller.abort(),
        () => controller.abort(),
      );
    }, timeoutMs);
    const settlement = Promise.resolve()
      .then(async () => {
        if ((job.deadlineAt ?? 0) <= now().getTime()) {
          timedOut = true;
          throw new OpsExecutionFailure("timeout", {});
        }
        const authority = controlAuthorities.get(job.operationId);
        if (authority) {
          const lease = controlLeases.get(job.operationId);
          if (lease) assertArtifactTargetLeaseForward(lease);
          if (literalProductionRuntime) {
            try {
              await assertManagedCliConfigurationPreflight(
                runtime,
                job.operation,
                contextFor(job, controller.signal, claim),
              );
            } catch (error) {
              if (
                error instanceof OpsExecutionFailure &&
                error.errorClass === "configuration_prerequisite"
              )
                retainConfigurationPreEffectRefusal(authority);
              throw error;
            }
          }
          if (job.operation.kind === "feedProxy.validateAndReload") {
            const digest = claim.capability.values.candidateDigest;
            if (typeof digest !== "string") throw Error("Original candidate claim missing");
            reserveFeedProxyValidation(authority, job.operation.candidateId, digest);
          }
          // The fixed DM pull runtime performs its source/target-index checks
          // under writer -> release lock, then begins immediately before Docker.
          if (
            job.operation.kind !== "coreService.restart" &&
            job.operation.kind !== "service.image.stage" &&
            job.operation.kind !== "backup.prune" &&
            // This fixed publisher begins only after validation, destination
            // materialization and compatibility checks, immediately before its
            // journaled managed-directory transaction.
            job.operation.kind !== "artifactTransfer.import" &&
            !(
              job.operation.kind === "service.pull" &&
              job.operation.serviceId === "data-manager" &&
              job.operation.candidateId
            )
          )
            beginControlEffect(authority);
        }
        try {
          return await dispatch(job.operation, runtime, contextFor(job, controller.signal, claim));
        } catch (error) {
          if (
            authority &&
            (job.operation.kind === "service.image.stage" || job.operation.kind === "backup.prune")
          ) {
            try {
              // The nominal producer checks the original started cell and all
              // children. A begun stage cannot be relabeled as unissued.
              retainConfigurationPreEffectRefusal(authority);
            } catch {
              // Existing begun/unknown evidence remains fenced.
            }
          }
          throw error;
        }
      })
      .then(
        async (rawResult) => {
          clearTimeout(timer);
          try {
            if (isTrustedConfigurationApplyOperation(job.operation)) {
              // Public status remains running until the terminal event is published.
              const result = configurationApplyResultSchema.parse(
                parseBoundedOpsResult(job.operation.kind, rawResult),
              );
              configurationEvidence = result;
              configurationResultsSettling.add(job.operationId);
              await transition(job, "succeeded", {
                result,
                errorClass: undefined,
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                timedOut ? "late_completion" : "success",
                startedAt,
              );
            } else if (stickyRecoveryRequired.has(job.operationId)) {
              await transition(job, "failed", {
                result: undefined,
                errorClass: "recovery_required",
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                "error",
                startedAt,
                "recovery_required",
              );
            } else if (
              (timedOut || job.state === "termination_pending") &&
              ((job.role === "api" &&
                (job.operation.kind === "backup.prune" ||
                  (job.operation.kind === "artifactTransfer.import" &&
                    (rawResult as { outcome?: string }).outcome === "committed"))) ||
                (job.role === "data-manager" &&
                  [
                    "motis.primary.stop",
                    "motis.staging.stop",
                    "motis.staging.restart",
                    "motis.primary.restart",
                    "motis.primary.promote",
                    "feedProxy.validateAndReload",
                    "transitousLock.approve",
                  ].includes(job.operation.kind)))
            ) {
              // These fixed leaf handlers return only after their host call
              // settles. Cancellation cannot erase a validated commit receipt
              // from an already-started call; no new forward phase is allowed.
              const result = parseBoundedOpsResult(job.operation.kind, rawResult);
              await transition(job, "succeeded", {
                result,
                errorClass: undefined,
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(job.role, job.operation.kind, job.resourceId, "late_completion", startedAt);
            } else if (timedOut) {
              await transition(job, "timed_out", {
                errorClass: "timeout",
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                "late_completion",
                startedAt,
                "timeout",
              );
            } else if (job.state === "termination_pending") {
              await transition(job, "failed", {
                result: undefined,
                errorClass: "runtime",
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                "terminated",
                startedAt,
                "runtime",
              );
            } else {
              const result = parseBoundedOpsResult(job.operation.kind, rawResult);
              await transition(job, "succeeded", {
                result,
                errorClass: undefined,
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(job.role, job.operation.kind, job.resourceId, "success", startedAt);
            }
          } catch {
            if (configurationEvidence) {
              // Journal failure must not erase observed pointer-commit evidence.
              // Retain it in memory; restart may still require reconciliation if
              // this final record cannot be made durable. Do not release an
              // uncheckpointed claim or retry the configuration mutation.
              const retained = { ...configurationEvidence, cleanupFailed: true };
              await transition(job, "succeeded", {
                result: retained,
                errorClass: undefined,
                terminalAt: now().getTime(),
              }).catch(() => {
                job.state = "succeeded";
                job.result = retained;
                job.errorClass = undefined;
                job.terminalAt = now().getTime();
              });
            } else {
              await transition(job, "failed", {
                result: undefined,
                errorClass: "runtime",
                terminalAt: now().getTime(),
              })
                .then(() => {
                  terminalDurable = true;
                })
                .catch(() => forceRecoveryRequired(job));
              audit(job.role, job.operation.kind, job.resourceId, "error", startedAt, "runtime");
            }
          } finally {
            try {
              if (
                configurationResultsSettling.delete(job.operationId) &&
                job.state === "succeeded"
              ) {
                job.cursor += 1;
                pushEvent(job, { cursor: job.cursor, type: "state", state: "succeeded" });
              }
              const authority = controlAuthorities.get(job.operationId);
              if (terminalDurable && authority && !recordStepTerminal(job))
                // The step's terminal is not recorded with its owner; the
                // maintenance stays held for recovery and nothing replays.
                stickyRecoveryRequired.add(job.operationId);
            } finally {
              // The slot is returned even when terminal bookkeeping throws.
              activeControllers.delete(job.operationId);
              active -= 1;
            }
          }
        },
        async (error) => {
          clearTimeout(timer);
          try {
            if (stickyRecoveryRequired.has(job.operationId)) {
              await transition(job, "failed", {
                result: undefined,
                errorClass: "recovery_required",
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                "error",
                startedAt,
                "recovery_required",
              );
            } else {
              const classification = timedOut
                ? { errorClass: "timeout" as const }
                : classify(error);
              if (
                !timedOut &&
                LEASED_KINDS.has(job.operation.kind) &&
                (isReportedProcessFailure(error) ||
                  isReportedProcessFailure((error as { cause?: unknown } | undefined)?.cause))
              )
                reportedFailures.add(job.operationId);
              let failureResult: OpsFailureResult | undefined;
              if (error instanceof OpsExecutionFailure) {
                const safe = opsFailureResultSchema.parse(error.failureResult);
                if (safe.diagnostics)
                  safe.diagnostics = {
                    ...safe.diagnostics,
                    tail: safe.diagnostics.tail.map((entry) => ({
                      ...entry,
                      message: safeProcessDiagnostic(entry.message),
                    })),
                  };
                failureResult = opsFailureResultSchema.parse(safe);
                if (
                  Buffer.byteLength(JSON.stringify(failureResult)) >
                  OPS_KIND_POLICIES[job.operation.kind].maxResultBytes
                )
                  failureResult = undefined;
                if (failureResult?.diagnostics)
                  job.diagnostics = processDiagnosticsSchema.parse(failureResult.diagnostics);
              }
              await transition(job, timedOut ? "timed_out" : "failed", {
                result: undefined,
                failureResult,
                errorClass: classification.errorClass,
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                timedOut ? "terminated" : "error",
                startedAt,
                classification.errorClass,
              );
            }
          } catch {
            await transition(job, "failed", {
              result: undefined,
              errorClass: "runtime",
              terminalAt: now().getTime(),
            })
              .then(() => {
                terminalDurable = true;
              })
              .catch(() => forceRecoveryRequired(job));
          } finally {
            // The slot is returned even when terminal bookkeeping throws.
            activeControllers.delete(job.operationId);
            active -= 1;
          }
        },
      );
    activeSettlements.set(job.operationId, settlement);
    void settlement.then(
      () => activeSettlements.delete(job.operationId),
      () => activeSettlements.delete(job.operationId),
    );
  };

  app.setErrorHandler((error, request, reply) => {
    const limited = (error as { statusCode?: number }).statusCode === 429;
    const statusCode = limited
      ? 429
      : (error as { statusCode?: number }).statusCode === 413
        ? 413
        : 400;
    return reply
      .code(statusCode)
      .send(
        redactedOpsError(requestIdFromBody(request.body), limited ? "busy" : "validation", error),
      );
  });
  app.get("/v1/protocol", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    if (!resolveRole(request.headers.authorization, options.tokens))
      return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    return reply.send(opsSuccess(requestId, { versions: [OPS_PROTOCOL_VERSION] }));
  });
  app.get("/health", async () => {
    return {
      ok: true,
      ...(options.releaseRecovery ? { releaseRecovery: options.releaseRecovery } : {}),
    };
  });

  const preparedImportsReconciling = new Map<string, Promise<void>>();
  const reconcileOriginalPreparedImport = (job: JobRecord): Promise<void> => {
    const installation = options.controlInstallation;
    if (
      !installation ||
      job.operation.kind !== "artifactTransfer.import" ||
      job.state === "succeeded"
    )
      return Promise.resolve();
    const prior = preparedImportsReconciling.get(job.operationId);
    if (prior) return prior;
    const pending = (async () => {
      try {
        const authority = restoreAdmittedControlExecution(installation, executionFor(job)),
          lease = restoreArtifactTargetLeaseForSettlement(authority);
        controlAuthorities.set(job.operationId, authority);
        controlLeases.set(job.operationId, lease);
        const publication = inspectArtifactPublication(authority);
        if (publication?.phase !== "committed") {
          cancelControlExecution(authority);
          await cancelArtifactTargetLease(lease);
        }
        const signal = AbortSignal.timeout(30000),
          claim = await resourceClaimer.claim(
            job.operation,
            opsOperationFingerprint(job.operation),
            signal,
            { role: job.role, operationKey: job.operationKey },
          );
        if (!claim) throw Error("Original import source unavailable");
        const context = contextFor(job, signal, claim),
          result = await recoverPreparedImportFiles(runtime, context);
        if (result) {
          retainControlEffectReceipt(authority, {
            outcome: result.outcome === "committed" ? "committed" : "contained",
            publication: result.outcome === "committed" ? "committed" : "not_started",
            receipt: { kind: "ops-result", result },
          });
          await settleArtifactTargetLeaseChild(
            lease,
            verifyControlEffectSettlement(installation, authority.execution),
          );
          await releaseArtifactTargetLease(lease);
          controlLeases.delete(job.operationId);
          if (result.outcome === "not_committed")
            await finishRestoredPreparedImport(runtime, context);
          await transition(job, "succeeded", {
            result,
            errorClass: undefined,
            terminalAt: now().getTime(),
          });
          stickyRecoveryRequired.delete(job.operationId);
        }
      } catch {
        /* Unknown/foreign paths or the operator-owned configuration lock retain their original fences. */
      }
    })().finally(() => preparedImportsReconciling.delete(job.operationId));
    preparedImportsReconciling.set(job.operationId, pending);
    return pending;
  };

  if (options.artifactTransfers && options.controlInstallation) {
    runtime["artifactTransfer.inspectClaim"] = async (operation) => {
      let found = await options.artifactTransfers!.inspectClaim(operation);
      if (!found || !["import-build", "validate-build"].includes(found.claim.use)) return found;
      const job = jobsById.get(found.claim.identity.executionId);
      if (
        !job ||
        !["artifactTransfer.import", "artifactTransfer.validate"].includes(job.operation.kind) ||
        !("stageId" in job.operation) ||
        job.operation.stageId !== operation.stageId ||
        !("ownerId" in job.operation) ||
        job.operation.ownerId !== operation.ownerId ||
        job.fingerprint !== operation.identity.fingerprint ||
        job.operationKey !== operation.identity.operationKey ||
        new Date(job.deadlineAt).toISOString() !== operation.identity.executionDeadlineAt ||
        job.terminalAt === undefined
      )
        return found;
      if (job.operation.kind === "artifactTransfer.import") {
        await reconcileOriginalPreparedImport(job);
        found = await options.artifactTransfers!.inspectClaim(operation);
        if (!found) return null;
      }
      try {
        const authority = restoreAdmittedControlExecution(
          options.controlInstallation!,
          executionFor(job),
        );
        if (
          job.operation.kind === "artifactTransfer.validate" &&
          found.claim.use === "validate-build"
        ) {
          const validation = await options.artifactTransfers!.recoverPreparedValidation(authority);
          cancelControlExecution(authority);
          retainControlEffectReceipt(authority, {
            outcome: "committed",
            publication: "committed",
            receipt: { kind: "ops-result", result: validation },
          });
          stickyRecoveryRequired.delete(job.operationId);
          return { ...found, validation };
        }
        if (job.operation.kind !== "artifactTransfer.import" || found.claim.use !== "import-build")
          return found;
        const publication = inspectSettledArtifactImport(authority);
        return { ...found, publication };
      } catch {
        return found;
      }
    };
  }

  // No replay during restart. Rejoin original signed admissions/adoptions and
  // retained own-effect proof; absent containment evidence keeps its fence.
  app.addHook("onReady", async () => {
    await options.artifactTransfers
      ?.reconcileTransferStages({ signal: AbortSignal.timeout(30000) })
      .catch(() => undefined);
    // Entries past their retention go before any record is restored, so a
    // record the control prune removed is never looked up for them.
    await pruneJobs(now().getTime());
    let changed = false;
    if (options.controlInstallation) {
      const accepted = restoreConfigurationMaintenanceControlJournal(options.controlInstallation),
        next = new Map(jobsById);
      const acceptedKeys = new Set(accepted.map((source) => source.operationKey));
      for (const job of jobsById.values())
        if (
          (job.operation.kind === "configurationMaintenance.decide" ||
            job.operation.kind === "configurationMaintenance.settle") &&
          !acceptedKeys.has(job.operationKey)
        )
          throw Error("Original maintenance control private source unavailable");
      for (const source of accepted) {
        const prior = jobsByKey.get(`api:${source.operationKey}`),
          byId = next.get(source.operationId);
        if (byId && byId !== prior) throw Error("Original maintenance control execution conflict");
        if (prior) {
          const identity = (record: PersistedOpsJob) => {
            const {
              state: _state,
              result: _result,
              updatedAt: _updated,
              terminalAt: _terminal,
              errorClass: _error,
              failureResult: _failure,
              terminationRequestedAt: _cancel,
              diagnostics: _diagnostics,
              ...binding
            } = record;
            return binding;
          };
          // Only the authenticated original owner can supply this unresolved
          // projection. The secondary journal's interruption timestamp is not a
          // canonical completion and cannot prevent read-only recovery.
          const unresolvedSettle =
            source.operation.kind === "configurationMaintenance.settle" &&
            source.errorClass === "recovery_required" &&
            source.terminalAt === undefined;
          const priorUnresolvedSettle =
            source.operation.kind === "configurationMaintenance.settle" &&
            prior.state === "failed" &&
            prior.errorClass === "recovery_required" &&
            prior.result === undefined;
          if (
            canonicalJson(identity(persisted(prior))) !== canonicalJson(identity(source)) ||
            (!unresolvedSettle &&
              !priorUnresolvedSettle &&
              prior.terminalAt !== undefined &&
              canonicalJson(persisted(prior)) !== canonicalJson(source))
          )
            throw Error("Original maintenance control canonical conflict");
          if (canonicalJson(persisted(prior)) === canonicalJson(source)) continue;
        }
        const restored: JobRecord = {
          ...source,
          terminalAt: source.terminalAt === undefined ? undefined : Date.parse(source.terminalAt),
          cursor: prior?.cursor ?? 0,
          events: prior?.events ?? [],
          eventBytes: prior?.eventBytes ?? 0,
          eventsTruncated: true,
        };
        if (!prior) {
          // An entry already past its retention is not brought back, so it
          // cannot keep the records it names from the prune.
          if (!retainedJob(restored, now().getTime())) continue;
          if (journalFull(next.values(), restored))
            throw Error("Original maintenance control recovery capacity exceeded");
        }
        next.set(restored.operationId, restored);
        changed = true;
      }
      // Publish the exact canonical secondary projection before making it
      // visible to HTTP lookup. Failure leaves the original private source.
      if (changed) {
        await journal.replace([...next.values()].map(persisted));
        for (const [id, restored] of next) {
          jobsById.set(id, restored);
          jobsByKey.set(`${restored.role}:${restored.operationKey}`, restored);
        }
      }
    }
    for (const job of jobsById.values()) {
      if (
        job.operation.kind === "artifactTransfer.import" &&
        job.state !== "succeeded" &&
        options.controlInstallation
      )
        await reconcileOriginalPreparedImport(job);
      if (job.controlAdoption) {
        try {
          if (!options.controlInstallation) throw Error("Control trust unavailable");
          const execution = executionFor(job);
          if (job.state === "succeeded" && job.operation.kind === "configurationHandoff.prepare") {
            retainedControlAdoptionAssertion(
              options.controlInstallation,
              job.controlAdoption,
              execution,
            );
            assertRetainedConfigurationHandoffPreparation(
              restoreAdmittedControlExecution(options.controlInstallation, execution),
              job.result,
            );
          } else if (job.state === "succeeded") {
            verifyRetainedArtifactTargetSettlement(
              options.controlInstallation,
              job.controlAdoption,
              execution,
            );
          } else {
            const assertion = retainedControlAdoptionAssertion(
              options.controlInstallation,
              job.controlAdoption,
              execution,
            );
            const admission = inspectControlAdmission(options.controlInstallation, {
              rawHeaders: ["x-openmapx-control-delegation", assertion],
              transportPrincipal: "data-manager",
              kind: job.operation.kind,
              operation: job.operation,
              operationKey: job.operationKey,
              operationFingerprint: execution.operationFingerprint,
              requestedDeadlineAt: execution.deadlineAt,
            });
            const lease = await admission.adopt(execution);
            const authority = restoreAdmittedControlExecution(
              options.controlInstallation,
              execution,
            );
            controlLeases.set(job.operationId, lease);
            controlAuthorities.set(job.operationId, authority);
            if (job.operation.kind === "transitousLock.approve") {
              const published = await readCommittedCatalogApproval(
                runtime,
                authority,
                lease,
                job.operation,
              );
              if (published) {
                retainControlEffectReceipt(authority, {
                  outcome: "committed",
                  publication: "committed",
                  receipt: { kind: "ops-result", result: published.result },
                });
                const restored: JobRecord = {
                  ...job,
                  state: "succeeded",
                  result: published.result,
                  errorClass: undefined,
                  failureResult: undefined,
                  terminalAt: published.terminalAt,
                  updatedAt: new Date(published.terminalAt).toISOString(),
                };
                await journal.replace(
                  [...jobsById.values()].map((value) =>
                    persisted(value === job ? restored : value),
                  ),
                );
                Object.assign(job, restored);
                changed = true;
              }
            }
            await settleArtifactTargetLeaseChild(
              lease,
              verifyControlEffectSettlement(options.controlInstallation, execution),
            );
          }
        } catch {
          job.controlAdoption = { ...job.controlAdoption, phase: "recovery_required" };
          job.state = "failed";
          job.errorClass = "recovery_required";
          job.result = undefined;
          stickyRecoveryRequired.add(job.operationId);
          changed = true;
        }
      }
    }
    if (options.controlInstallation && options.artifactTransfers) {
      for (const job of jobsById.values())
        if (job.operation.kind === "artifactTransfer.import" && job.terminalAt !== undefined) {
          try {
            await options.artifactTransfers.reconcileReleasedPreparedImport(
              restoreAdmittedControlExecution(options.controlInstallation, executionFor(job)),
            );
          } catch {
            /* No conclusive nonissuance/root release; keep claim pinned. */
          }
        }
    }
    if (changed) await journal.replace([...jobsById.values()].map(persisted));
    // A step whose terminal was journaled before its owner record was updated
    // (the agent stopped in between) is recorded now; recording is idempotent.
    for (const job of jobsById.values())
      if (job.terminalAt !== undefined && !recoveryRequired(job) && !recordStepTerminal(job))
        console.warn("Maintenance step terminal not recorded", job.operationId);
    if (options.controlInstallation) {
      const prune = startControlPrune(options.controlInstallation, {
        onError: (error) => console.warn("Control record prune failed", error),
        keep: (operationKey) =>
          newestStagedCoordinatorKey() === operationKey || journalReferences(operationKey),
      });
      stopControlPrune = prune.stop;
      await prune.ready;
    }
  });

  app.post(
    "/v1/operations",
    { bodyLimit: options.bodyLimit ?? CANDIDATE_BODY_LIMIT },
    async (request, reply) => {
      const startedAt = Date.now();
      const requestId = requestIdFromBody(request.body);
      const role = resolveRole(request.headers.authorization, options.tokens);
      if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
      let kind = operationKindFromBody(request.body);
      let resourceId: string = kind;
      try {
        const parsed = parseOpsRequest(request.body, { role });
        const requestLimit =
          parsed.operation.kind === "configuration.candidate.retain"
            ? CANDIDATE_BODY_LIMIT
            : parsed.operation.kind === "transitousLock.propose" || parsed.payload
              ? 772 * 1024
              : (options.bodyLimit ?? DEFAULT_BODY_LIMIT);
        if (Buffer.byteLength(JSON.stringify(request.body), "utf8") > requestLimit)
          throw new RequestGuardError("validation", 413);
        const operation = immutableSnapshot(parsed.operation);
        kind = operation.kind;
        resourceId = opsResourceId(operation);
        const nowMs = now().getTime();
        const timing = validateTiming(parsed.issuedAt, parsed.expiresAt, nowMs);
        replay.accept(parsed.requestId, timing.expiresAtMs, nowMs);
        if (
          operation.kind === "lease.acquire" ||
          operation.kind === "lease.read" ||
          operation.kind === "lease.update" ||
          operation.kind === "lease.settleChild"
        ) {
          if (!options.controlInstallation || !options.leaseStore)
            throw new RequestGuardError("recovery_required", 409);
          let value: unknown;
          try {
            value = await runLeaseOperation(
              options.controlInstallation,
              options.leaseStore,
              role,
              operation,
            );
          } catch (error) {
            if (error instanceof LeaseRefused) throw new RequestGuardError("authorization", 403);
            // A busy store lock or a file system error may come after the store
            // was written; only a lease rule refusal certainly wrote nothing.
            if (error instanceof services.LockBusyError || (error as { code?: unknown }).code)
              throw new RequestGuardError("runtime", 500);
            throw new RequestGuardError("conflict", 409);
          }
          return reply
            .code(200)
            .send(opsSuccess(parsed.requestId, { execution: "sync", kind, value }));
        }
        const policy = OPS_KIND_POLICIES[operation.kind];
        const operationFingerprint = opsOperationFingerprint(operation);
        if (
          operation.kind === "service.pull" &&
          operation.serviceId === "data-manager" &&
          !operation.candidateId
        )
          throw new OpsExecutionFailure("configuration_prerequisite", {});
        let parent: VerifiedParentExecution | undefined;
        let configurationMaintenanceControl:
          | import("./configuration-maintenance-store").ConfigurationMaintenanceControlOwner
          | undefined;
        let maintenanceStepAdmission:
          | Awaited<ReturnType<typeof prepareOwnedConfigurationMaintenanceStepAdmission>>
          | undefined;
        let controlAdmission:
          | ReturnType<typeof inspectControlAdmission>
          | Awaited<ReturnType<typeof prepareOwnedConfigurationMaintenanceStepAdmission>>
          | undefined;
        const parentHeader = request.headers["x-openmapx-parent-execution"];
        const delegationHeader = request.headers["x-openmapx-control-delegation"];
        // Approval is exclusively a borrowed activation leaf. Installing its
        // future validation runtime must never enable a bearer-only root path.
        if (operation.kind === "transitousLock.approve" && delegationHeader === undefined)
          throw new RequestGuardError("authorization", 403);
        try {
          readControlHeaders(request.raw.rawHeaders);
        } catch {
          throw new RequestGuardError("authorization", 403);
        }
        if (delegationHeader !== undefined) {
          if (!options.controlInstallation || role !== "data-manager" || parentHeader !== undefined)
            throw new RequestGuardError("authorization", 403);
          try {
            controlAdmission = inspectControlAdmission(options.controlInstallation, {
              rawHeaders: request.raw.rawHeaders,
              transportPrincipal: "data-manager",
              kind,
              operation,
              operationKey: parsed.operationKey,
              operationFingerprint,
              requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
            });
            parent = controlAdmission.parent;
          } catch {
            throw new RequestGuardError("authorization", 403);
          }
        }
        if (parentHeader !== undefined) {
          if (role !== "api" || typeof parentHeader !== "string")
            throw new RequestGuardError("authorization", 403);
          try {
            parent = verifyApiJobParentExecution(parentHeader, {
              operationKey: parsed.operationKey,
              operationFingerprint,
              requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
            });
          } catch {
            throw new RequestGuardError("authorization", 403);
          }
        }
        if (
          operation.kind === "configurationMaintenance.inspect" ||
          operation.kind === "configurationMaintenance.decide" ||
          operation.kind === "configurationMaintenance.settle"
        ) {
          if (!options.controlInstallation || !parent)
            throw new RequestGuardError("authorization", 403);
          try {
            configurationMaintenanceControl = admitConfigurationMaintenanceControlOwner(
              options.controlInstallation,
              operation,
              parent,
              {
                operationKey: parsed.operationKey,
                requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
              },
            );
          } catch (error) {
            if (error instanceof ConfigurationMaintenanceControlUnauthorized)
              throw new RequestGuardError("authorization", 403);
            throw new RequestGuardError(
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "not_found"
                : "recovery_required",
              (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 409,
            );
          }
        }
        if (
          (isTrustedConfigurationApplyOperation(operation) ||
            operation.kind === "configuration.hardlinks.apply" ||
            operation.kind === "configurationHandoff.prepare" ||
            operation.kind === "service.recreate" ||
            operation.kind === "service.recreateIsolated") &&
          operation.maintenanceId
        ) {
          if (
            !options.controlInstallation ||
            role !== "api" ||
            !parent ||
            typeof parentHeader !== "string"
          )
            throw new RequestGuardError("authorization", 403);
          try {
            maintenanceStepAdmission = await prepareOwnedConfigurationMaintenanceStepAdmission(
              runtime,
              options.controlInstallation,
              operation,
              parent,
              {
                operationKey: parsed.operationKey,
                requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
                parentAssertion: parentHeader,
                signal: AbortSignal.timeout(15000),
              },
            );
            controlAdmission = maintenanceStepAdmission;
            parent = maintenanceStepAdmission.parent;
          } catch (error) {
            if (error instanceof ConfigurationMaintenanceControlUnauthorized)
              throw new RequestGuardError("authorization", 403);
            if (error instanceof ConfigurationMaintenanceControlConflict)
              throw new RequestGuardError("recovery_required", 409);
            throw error;
          }
        }
        const normalize = (
          originalAdmittedAt: number,
          deploymentBudgetMs = Math.min(
            policy.timeoutMs,
            options.operationTimeoutMs ?? policy.timeoutMs,
          ),
        ) => {
          try {
            if (maintenanceStepAdmission)
              return {
                admittedAt: maintenanceStepAdmission.boundAt,
                deadlineAt: maintenanceStepAdmission.execution.deadlineAt,
                fingerprint: maintenanceStepAdmission.execution.fingerprint,
              };
            if (
              operation.kind === "configurationMaintenance.inspect" &&
              configurationMaintenanceControl
            )
              return normalizeConfigurationMaintenanceInspection(
                configurationMaintenanceControl,
                operation,
                parsed.operationKey,
                originalAdmittedAt,
                deploymentBudgetMs,
              );
            if (
              configurationMaintenanceControl &&
              (operation.kind === "configurationMaintenance.settle" ||
                (operation.kind === "configurationMaintenance.decide" &&
                  operation.decision === "abandon"))
            )
              return normalizeConfigurationMaintenanceRecoveryControl(
                configurationMaintenanceControl,
                operation,
                parsed.operationKey,
                originalAdmittedAt,
                deploymentBudgetMs,
              );
            return normalizeExecutionAdmission({
              kind,
              operationKey: parsed.operationKey,
              operationFingerprint,
              admittedAt: originalAdmittedAt,
              requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
              parent,
              deploymentBudgetMs,
            });
          } catch {
            throw new RequestGuardError("validation", 400);
          }
        };
        let normalized: ReturnType<typeof normalize>;
        const fingerprint = operationFingerprint; // Existing sealed claims bind the body, never execution timing.
        const matchesRetained = (job: JobRecord): boolean => {
          try {
            return (
              job.fingerprint === normalize(job.admittedAt, job.deploymentBudgetMs).fingerprint
            );
          } catch {
            return false;
          }
        };
        if (policy.execution === "async") {
          await pruneJobs(nowMs);
          const ownerKey = `${role}:${parsed.operationKey}`;
          const existing = jobsByKey.get(ownerKey);
          if (existing) {
            if (!matchesRetained(existing)) throw new RequestGuardError("conflict", 409);
            return reply.code(202).send(opsSuccess(parsed.requestId, admissionFor(existing)));
          }
          if (journalFull()) throw new RequestGuardError("busy", 429);
        }
        const pendingHandoffs = configurationHandoffPendingMaintenanceIds(runtime);
        if (
          pendingHandoffs.size &&
          !RELEASE_RECOVERY_READ_KINDS.has(kind) &&
          !(
            configurationMaintenanceControl &&
            "maintenanceId" in operation &&
            operation.maintenanceId &&
            pendingHandoffs.has(operation.maintenanceId)
          )
        )
          throw new RequestGuardError("busy", 409);
        if (options.releaseRecovery?.ready === false && !RELEASE_RECOVERY_READ_KINDS.has(kind))
          throw new RequestGuardError("recovery_required", 409);
        if (
          opsKindRequiresControlAuthority(operation.kind) &&
          !controlAdmission &&
          !configurationMaintenanceControl
        ) {
          if (!options.controlInstallation) throw new RequestGuardError("recovery_required", 409);
          try {
            const key = parseControlRootOperationKey(parsed.operationKey);
            if (key.notAfter !== parsed.execution?.requestedDeadlineAt) throw Error();
          } catch {
            throw new RequestGuardError("validation", 400);
          }
          try {
            assertFreshControlRoot(parsed.operationKey, parsed.execution?.requestedDeadlineAt);
          } catch {
            throw new RequestGuardError("recovery_required", 409);
          }
        }
        normalized = normalize(nowMs);
        if (active >= maxConcurrency) throw new RequestGuardError("busy", 429);
        active += 1;
        const claimController = new AbortController();
        const claimExecution = Promise.resolve().then(() =>
          resourceClaimer.claim(operation, fingerprint, claimController.signal, {
            role,
            operationKey: parsed.operationKey,
            ...(maintenanceStepAdmission ? { maintenanceStep: maintenanceStepAdmission } : {}),
          }),
        );
        let claimTimer: ReturnType<typeof setTimeout> | undefined;
        let claim: Awaited<ReturnType<OpsResourceClaimer["claim"]>>;
        try {
          claim = await Promise.race([
            claimExecution,
            new Promise<never>((_resolve, reject) => {
              claimTimer = setTimeout(() => {
                claimController.abort();
                reject(new RequestGuardError("timeout", 504));
              }, options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS);
            }),
          ]);
          if (claimTimer !== undefined) clearTimeout(claimTimer);
        } catch (error) {
          if (claimTimer !== undefined) clearTimeout(claimTimer);
          if (error instanceof RequestGuardError && error.errorClass === "timeout") {
            void claimExecution.then(
              (lateClaim) => {
                active -= 1;
                audit(role, kind, resourceId, "late_completion", startedAt, "timeout");
              },
              () => {
                active -= 1;
                audit(role, kind, resourceId, "terminated", startedAt, "timeout");
              },
            );
            audit(role, kind, resourceId, "timeout", startedAt, "timeout");
            return reply.code(504).send(redactedOpsError(parsed.requestId, "timeout"));
          }
          active -= 1;
          throw error;
        }
        let coordinatorCapture: CoordinatorPullOwnershipObservation | undefined;
        try {
          if (
            !claim ||
            claim.fingerprint !== fingerprint ||
            opsOperationFingerprint(claim.operation as OpsOperation) !== fingerprint ||
            !claim.capability ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claim.capability.revisionId) ||
            !claim.capability.values ||
            typeof claim.capability.values !== "object" ||
            Array.isArray(claim.capability.values) ||
            Object.keys(claim.capability.values).length > 64 ||
            Object.entries(claim.capability.values).some(
              ([key, value]) =>
                !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key) ||
                (value !== null && !["string", "number", "boolean"].includes(typeof value)) ||
                (typeof value === "number" && !Number.isFinite(value)),
            ) ||
            Buffer.byteLength(JSON.stringify(claim.capability), "utf8") > 512 * 1024
          ) {
            throw new OpsContractError("authorization", "Operation resource is not permitted");
          }
          if (operation.kind === "service.pull" && operation.candidateId)
            coordinatorCapture = consumeCoordinatorPullOwnershipCapture(claim, {
              operationFingerprint: fingerprint,
              candidateId: operation.candidateId,
              policyRevision: claim.capability.revisionId,
            });
          claim = immutableSnapshot({
            fingerprint: claim.fingerprint,
            operation: claim.operation,
            source: claim.source,
            // The payload is held in memory for the run only, never journaled.
            capability: parsed.payload
              ? { ...claim.capability, trustedConfiguration: parsed.payload }
              : claim.capability,
          });
        } catch {
          active -= 1;
          throw new OpsContractError("authorization", "Operation resource is not permitted");
        }

        if (policy.execution === "async") {
          const ownerKey = `${role}:${parsed.operationKey}`;
          // A held target is retried once, after a short grace spent outside the
          // admission lock, so a holder that is finishing can release meanwhile.
          let graceSpent = false;
          const admit = async () => {
            const retained = jobsByKey.get(ownerKey);
            if (retained) {
              if (!matchesRetained(retained)) {
                throw new RequestGuardError("conflict", 409);
              }
              return { type: "retained", job: retained } as const;
            }
            if (journalFull()) throw new RequestGuardError("busy", 429);
            if (
              options.controlInstallation &&
              opsKindRequiresControlAuthority(parsed.operation.kind)
            )
              try {
                assertControlStorageAvailable(options.controlInstallation);
              } catch {
                throw new RequestGuardError("busy", 429);
              }
            if (normalized.deadlineAt <= now().getTime())
              throw new RequestGuardError("timeout", 504);
            const timestamp = new Date(normalized.admittedAt).toISOString();
            let operationId: string | undefined = controlAdmission?.execution.executionId;
            if (operationId && jobsById.has(operationId))
              throw new RequestGuardError("conflict", 409);
            try {
              for (let attempt = 0; !operationId && attempt < MAX_JOB_ID_ATTEMPTS; attempt += 1) {
                const candidate = `job1_${Buffer.from(randomBytes(18)).toString("base64url")}`;
                if (OPERATION_ID_PATTERN.test(candidate) && !jobsById.has(candidate)) {
                  operationId = candidate;
                  break;
                }
              }
            } catch {
              throw new RequestGuardError("runtime", 500);
            }
            if (!operationId) throw new RequestGuardError("busy", 429);
            const job: JobRecord = {
              ...(controlAdmission
                ? {
                    controlAdoption: {
                      leaseId: controlAdmission.leaseId,
                      delegationId: controlAdmission.delegationId,
                      phase: "pending-adoption" as const,
                    },
                  }
                : {}),
              role,
              operation,
              operationId,
              operationKey: parsed.operationKey,
              executionVersion: 2,
              requestVersion: parsed.version,
              ...normalized,
              operationFingerprint,
              requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
              parent,
              deploymentBudgetMs: maintenanceStepAdmission
                ? opsExecutionBudget(operation.kind).processMs
                : Math.min(policy.timeoutMs, options.operationTimeoutMs ?? policy.timeoutMs),
              resourceId,
              state: "queued",
              submittedAt: timestamp,
              updatedAt: timestamp,
              cursor: 0,
              events: [],
              eventBytes: 0,
              eventsTruncated: false,
            };
            if (
              configurationMaintenanceControl &&
              operation.kind === "configurationMaintenance.decide"
            ) {
              try {
                if (job.requestedDeadlineAt === undefined || typeof parentHeader !== "string")
                  throw new ConfigurationMaintenanceControlUnauthorized(
                    "Actual decision request source required",
                  );
                const continueObservation =
                  operation.decision === "continue"
                    ? await prepareMaintenanceContinueObservation(
                        runtime,
                        configurationMaintenanceControlOwnerState(
                          configurationMaintenanceControl,
                          operation,
                          job.operationKey,
                        ).authority,
                        AbortSignal.any([
                          claimController.signal,
                          AbortSignal.timeout(Math.max(1, job.deadlineAt - Date.now())),
                        ]),
                      )
                    : undefined;
                retainConfigurationMaintenanceDecisionControl(
                  configurationMaintenanceControl,
                  operation,
                  executionFor(job),
                  {
                    admittedAt: job.admittedAt,
                    requestedDeadlineAt: job.requestedDeadlineAt,
                    parentAssertion: parentHeader,
                    requestVersion: job.requestVersion,
                    deploymentBudgetMs: job.deploymentBudgetMs,
                  },
                  continueObservation,
                );
                maintenanceControls.set(job.operationId, configurationMaintenanceControl);
              } catch (error) {
                if (error instanceof ConfigurationMaintenanceControlUnauthorized)
                  throw new RequestGuardError("authorization", 403);
                if (error instanceof ConfigurationMaintenanceControlConflict)
                  throw new RequestGuardError("conflict", 409);
                throw error;
              }
            }
            if (
              configurationMaintenanceControl &&
              operation.kind === "configurationMaintenance.settle"
            ) {
              try {
                if (job.requestedDeadlineAt === undefined || typeof parentHeader !== "string")
                  throw new ConfigurationMaintenanceControlUnauthorized(
                    "Actual settlement request source required",
                  );
                retainConfigurationMaintenanceSettleControl(
                  configurationMaintenanceControl,
                  operation,
                  executionFor(job),
                  {
                    admittedAt: job.admittedAt,
                    requestedDeadlineAt: job.requestedDeadlineAt,
                    parentAssertion: parentHeader,
                    requestVersion: job.requestVersion,
                    deploymentBudgetMs: job.deploymentBudgetMs,
                  },
                );
                maintenanceControls.set(job.operationId, configurationMaintenanceControl);
              } catch (error) {
                if (error instanceof ConfigurationMaintenanceControlUnauthorized)
                  throw new RequestGuardError("authorization", 403);
                if (error instanceof ConfigurationMaintenanceControlConflict)
                  throw new RequestGuardError("conflict", 409);
                throw error;
              }
            }
            // Prepared compatibility checks are read-only and precede durable
            // root admission. A stale preview creates no uncertain host owner.
            const preparedArtifactImport =
              job.operation.kind === "artifactTransfer.import"
                ? await prepareArtifactImportAdmission(
                    runtime,
                    executionFor(job),
                    job.operation,
                    options.controlInstallation
                      ? controlRegisteredServiceIds(options.controlInstallation)
                      : [],
                  )
                : undefined;
            let coordinatorBaseline:
              | Awaited<ReturnType<typeof prepareCoordinatorPullBaseline>>
              | undefined;
            if (job.operation.kind === "service.pull" && job.operation.candidateId) {
              if (!options.controlInstallation || !coordinatorCapture)
                throw new RequestGuardError("authorization", 403);
              try {
                coordinatorBaseline = await prepareCoordinatorPullBaseline(
                  runtime,
                  options.controlInstallation,
                  {
                    operation: job.operation,
                    execution: executionFor(job),
                    parent: job.parent,
                    requestedDeadlineAt: job.requestedDeadlineAt,
                  },
                  coordinatorCapture,
                );
              } catch {
                throw new RequestGuardError("authorization", 403);
              }
            }
            // The target lease is the one admission: a held target refuses the
            // operation as busy before anything is recorded. Its targets, and a
            // maintenance plan, are read first; a failure there is raised once the
            // job is recorded, so the attempt stays visible.
            const rootAdmission =
              !controlAdmission &&
              !configurationMaintenanceControl &&
              opsKindRequiresControlAuthority(operation.kind);
            let admissionFailure: { error: unknown } | undefined;
            let maintenanceAdmission:
              | Awaited<ReturnType<typeof prepareConfigurationMaintenanceAdmission>>
              | undefined;
            let targets: string[] = [];
            let admittedLease: string | undefined;
            if (rootAdmission) {
              try {
                if (!options.controlInstallation) throw Error("Control trust unavailable");
                maintenanceAdmission =
                  job.operation.kind === "configurationMaintenance.prepare"
                    ? await prepareConfigurationMaintenanceAdmission(runtime, {
                        installation: options.controlInstallation,
                        execution: executionFor(job),
                        operation: job.operation,
                        apiParent:
                          job.parent ??
                          (() => {
                            throw Error("Original retained API maintenance parent required");
                          })(),
                        signal: claimController.signal,
                      })
                    : undefined;
                if (literalProductionRuntime)
                  replaceControlRegisteredServiceIds(
                    options.controlInstallation,
                    await productionRegisteredServiceIds(runtime),
                  );
                targets =
                  (maintenanceAdmission &&
                    configurationMaintenanceAdmissionState(maintenanceAdmission).plan.serviceIds) ??
                  (operation.kind === "artifactTransfer.export"
                    ? [
                        ...new Set([
                          operation.serviceId,
                          ...buildArtifactSpec(operation.serviceId).consumers,
                        ]),
                      ]
                    : "serviceId" in operation &&
                        ![
                          "service.start",
                          "service.recreate",
                          "service.recreateIsolated",
                          "service.update",
                        ].includes(operation.kind)
                      ? [operation.serviceId]
                      : controlRegisteredServiceIds(options.controlInstallation));
              } catch (error) {
                admissionFailure = { error };
              }
              if (!admissionFailure && LEASED_KINDS.has(operation.kind) && options.leaseStore)
                try {
                  admittedLease = (
                    await localLeaseBackend(options.leaseStore).acquire({
                      owner: executionFor(job),
                      ownerKind: operation.kind,
                      targets: operation.kind.startsWith("valhalla.") ? ["valhalla"] : targets,
                    })
                  ).leaseId;
                } catch (error) {
                  if (!(error instanceof TargetBusyError)) admissionFailure = { error };
                  else if (!graceSpent) throw new BusyAdmission(error.target);
                  else {
                    options.audit?.({
                      role,
                      kind,
                      resourceId,
                      result: "denied",
                      durationMs: Date.now() - startedAt,
                      errorClass: "busy",
                      heldBy: error.message,
                    });
                    throw new RequestGuardError("busy", 409, error.message);
                  }
                }
            }
            try {
              await journal.replace([...jobsById.values()].map(persisted).concat(persisted(job)));
            } catch (error) {
              // Nothing was recorded, so nothing ran under the lease.
              if (admittedLease && options.leaseStore)
                await abandonUnstartedLease(options.leaseStore, admittedLease, executionFor(job));
              throw error;
            }
            jobsById.set(job.operationId, job);
            jobsByKey.set(ownerKey, job);
            if (rootAdmission) {
              try {
                if (admissionFailure) throw admissionFailure.error;
                if (!options.controlInstallation) throw Error("Control trust unavailable");
                const maintenancePlan =
                  maintenanceAdmission &&
                  configurationMaintenanceAdmissionState(maintenanceAdmission).plan;
                const fixedDataPlan = isFixedSingleDataCommand(job.operation.kind)
                  ? planFixedSingleDataCommand(
                      executionFor(job),
                      job.operation,
                      targets,
                      "regionId" in job.operation && job.operation.regionId === undefined
                        ? resolveDataDefaultRegion(runtime)
                        : undefined,
                    )
                  : undefined;
                const dataUpdatePlan =
                  job.operation.kind === "data.update"
                    ? prepareDataUpdateAdmission(runtime, executionFor(job), job.operation, targets)
                    : undefined;
                const artifactImport = preparedArtifactImport;
                const hardlinksPlan =
                  artifactImport?.hardlinks ??
                  (job.operation.kind === "configuration.hardlinks.apply"
                    ? prepareConfigurationHardlinksAdmission(
                        runtime,
                        executionFor(job),
                        job.operation,
                        targets,
                      )
                    : undefined);
                const lifecyclePlan =
                  job.operation.kind === "service.update"
                    ? prepareServiceUpdateAdmission(
                        runtime,
                        executionFor(job),
                        job.operation,
                        targets,
                      )
                    : undefined;
                const authority = retainAdmittedControlExecution(options.controlInstallation, {
                  execution: executionFor(job),
                  operation: job.operation,
                  kind: job.operation.kind,
                  admittedAt: job.admittedAt,
                  requestedDeadlineAt: job.requestedDeadlineAt,
                  parent: job.parent,
                  serviceIds: targets,
                  ...(fixedDataPlan ? { reservations: [fixedDataPlan.rootReservation] } : {}),
                  ...(dataUpdatePlan
                    ? {
                        reservations: [
                          dataUpdatePlan.dataReservation,
                          dataUpdatePlan.finalizationReservation,
                        ],
                      }
                    : {}),
                  ...(hardlinksPlan
                    ? { reservations: hardlinksPlan.reservation ? [hardlinksPlan.reservation] : [] }
                    : {}),
                  ...(lifecyclePlan ? { reservations: [lifecyclePlan.rootReservation] } : {}),
                  ...(maintenancePlan ? { reservations: maintenancePlan.reservations } : {}),
                  ...(coordinatorBaseline ? { coordinatorPullBaseline: coordinatorBaseline } : {}),
                });
                if (fixedDataPlan) retainFixedSingleDataPlan(authority, fixedDataPlan);
                if (dataUpdatePlan) retainDataUpdatePlan(authority, dataUpdatePlan);
                if (hardlinksPlan) retainGenerationHardlinksOwnerPlan(authority, hardlinksPlan);
                if (artifactImport) retainArtifactImportPlan(authority, artifactImport.plan);
                if (lifecyclePlan) retainFixedServiceLifecyclePlan(authority, lifecyclePlan);
                controlAuthorities.set(job.operationId, authority);
                if (LEASED_KINDS.has(job.operation.kind)) {
                  const lease = await acquireArtifactTargetLease({
                    serviceIds: job.operation.kind.startsWith("valhalla.") ? ["valhalla"] : targets,
                    owner: authority,
                  });
                  controlLeases.set(job.operationId, lease);
                  if (maintenanceAdmission)
                    retainOwnedConfigurationMaintenance(authority, lease, maintenanceAdmission);
                }
              } catch (error) {
                // Nothing has started yet, so a lease taken at admission holds nothing.
                if (admittedLease && options.leaseStore) {
                  controlLeases.delete(job.operationId);
                  await abandonUnstartedLease(options.leaseStore, admittedLease, executionFor(job));
                }
                forceRecoveryRequired(job);
                await journal.replace([...jobsById.values()].map(persisted));
                throw error;
              }
            }
            if (controlAdmission) {
              const adoption = {
                leaseId: controlAdmission.leaseId,
                delegationId: controlAdmission.delegationId,
              };
              try {
                if (!options.controlInstallation)
                  throw Error("Missing durable control admission context");
                const lease = await controlAdmission.adopt(executionFor(job));
                const authority = retainAdmittedControlExecution(options.controlInstallation, {
                  execution: executionFor(job),
                  kind: job.operation.kind,
                  operation: job.operation,
                  admittedAt: job.admittedAt,
                  requestedDeadlineAt: job.requestedDeadlineAt,
                  parent: job.parent,
                  serviceIds: lease.serviceIds,
                  ...(maintenanceStepAdmission
                    ? { reservations: maintenanceStepAdmission.reservations }
                    : {}),
                });
                if (maintenanceStepAdmission) bindBorrowedControlExecution(lease, authority);
                if (
                  maintenanceStepAdmission &&
                  job.operation.kind === "configuration.hardlinks.apply"
                )
                  retainGenerationHardlinksOwnerPlan(
                    authority,
                    prepareConfigurationHardlinksAdmission(
                      runtime,
                      executionFor(job),
                      job.operation,
                      lease.serviceIds,
                    ),
                  );
                controlLeases.set(job.operationId, lease);
                controlAuthorities.set(job.operationId, authority);
                job.controlAdoption = { ...adoption, phase: "ready" };
                await journal.replace([...jobsById.values()].map(persisted));
              } catch (error) {
                // The receiver may already have adopted. This identity remains
                // observable as recovery-required and is never dispatched again.
                job.controlAdoption = { ...adoption, phase: "recovery_required" };
                forceRecoveryRequired(job);
                try {
                  await journal.replace([...jobsById.values()].map(persisted));
                } catch (persistence) {
                  throw new AggregateError(
                    [error, persistence],
                    "Control adoption requires reconciliation",
                  );
                }
                throw error;
              }
            }
            return { type: "new", job } as const;
          };
          const admission = await withAdmissionLock(admit)
            .catch(async (error) => {
              if (!(error instanceof BusyAdmission) || !options.leaseStore) throw error;
              await waitForTargetRelease(
                options.leaseStore,
                error.target,
                Math.min(Date.now() + 5000, normalized.deadlineAt),
                claimController.signal,
              );
              graceSpent = true;
              return withAdmissionLock(admit);
            })
            .catch(async (error) => {
              active -= 1;
              throw error instanceof RequestGuardError
                ? error
                : error instanceof TargetBusyError
                  ? new RequestGuardError("busy", 409, error.message)
                  : new RequestGuardError("runtime", 500);
            });
          if (admission.type === "retained") {
            active -= 1;
            return reply.code(202).send(opsSuccess(parsed.requestId, admissionFor(admission.job)));
          }
          const { job } = admission;
          if (normalized.deadlineAt <= now().getTime()) {
            stickyRecoveryRequired.add(job.operationId);
            await transition(job, "failed", {
              result: undefined,
              errorClass: "recovery_required",
              terminalAt: now().getTime(),
            }).catch(() => forceRecoveryRequired(job));
            active -= 1;
            throw new RequestGuardError("runtime", 500);
          }
          await runAsync(job, startedAt, claim);
          return reply.code(202).send(opsSuccess(parsed.requestId, admissionFor(job)));
        }
        const controller = new AbortController();
        if (normalized.deadlineAt <= now().getTime()) {
          active -= 1;
          throw new RequestGuardError("runtime", 500);
        }
        const timeoutMs = Math.max(0, normalized.deadlineAt - now().getTime());
        const execution = Promise.resolve().then(() => {
          if (normalized.deadlineAt <= now().getTime()) throw new RequestGuardError("timeout", 504);
          return dispatch(operation, runtime, {
            signal: controller.signal,
            ...(configurationMaintenanceControl ? { configurationMaintenanceControl } : {}),
            execution: Object.freeze({
              executor: "ops-agent",
              principal: role,
              executionId: `job1_${Buffer.from(randomBytes(18)).toString("base64url")}`,
              operationKey: parsed.operationKey,
              operationFingerprint,
              fingerprint: normalized.fingerprint,
              deadlineAt: normalized.deadlineAt,
            }),
            emitLog: () => undefined,
            claim,
          });
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeoutResult = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new RequestGuardError("timeout", 504));
            }, timeoutMs);
          });
          const rawResult = await Promise.race([execution, timeoutResult]);
          clearTimeout(timeout);
          const value = parseBoundedOpsResult(operation.kind, rawResult);
          audit(role, kind, resourceId, "success", startedAt);
          const envelope = opsSuccess(parsed.requestId, { execution: "sync", kind, value });
          if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > OPS_MAX_HTTP_RESPONSE_BYTES) {
            throw new RequestGuardError("runtime", 500);
          }
          active -= 1;
          return reply.code(200).send(envelope);
        } catch (error) {
          if (timeout !== undefined) clearTimeout(timeout);
          if (error instanceof RequestGuardError && error.errorClass === "timeout") {
            void execution.then(
              () => {
                active -= 1;
                audit(role, kind, resourceId, "late_completion", startedAt, "timeout");
              },
              () => {
                active -= 1;
                audit(role, kind, resourceId, "terminated", startedAt, "timeout");
              },
            );
            audit(role, kind, resourceId, "timeout", startedAt, "timeout");
            return reply.code(504).send(redactedOpsError(parsed.requestId, "timeout"));
          }
          active -= 1;
          throw error;
        }
      } catch (error) {
        const classification = classify(error);
        audit(
          role,
          kind,
          resourceId,
          classification.errorClass === "authorization" ? "denied" : "error",
          startedAt,
          classification.errorClass,
        );
        return reply
          .code(classification.statusCode)
          .send(redactedOpsError(requestId, classification.errorClass, error));
      }
    },
  );

  app.get("/v1/operation-keys/:operationKey", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    if (!supportedPeer(request))
      return reply.code(400).send(redactedOpsError(requestId, "unsupported_peer"));
    const operationKey = (request.params as { operationKey?: unknown }).operationKey;
    if (typeof operationKey !== "string" || !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(operationKey)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsByKey.get(`${role}:${operationKey}`);
    if (!job) return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    const fingerprint = request.headers["x-ops-operation-fingerprint"];
    // The lookup names the operation body it would submit; an optional
    // execution fingerprint must match the retained identity as well.
    const bodyFingerprint = request.headers["x-ops-body-fingerprint"];
    if (typeof bodyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(bodyFingerprint))
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    if (bodyFingerprint !== job.operationFingerprint)
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    if (
      fingerprint !== undefined &&
      fingerprint !== job.fingerprint &&
      fingerprint !== bodyFingerprint
    )
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    const requested = request.headers["x-ops-requested-deadline"];
    if (requested !== undefined) {
      const requestedDeadlineAt = Number(requested);
      if (
        typeof requested !== "string" ||
        !Number.isSafeInteger(requestedDeadlineAt) ||
        requestedDeadlineAt < 0
      )
        return reply.code(400).send(redactedOpsError(requestId, "validation"));
      let deadlineAt = Math.min(
        requestedDeadlineAt,
        job.parent?.deadlineAt ?? Infinity,
        job.admittedAt + job.deploymentBudgetMs,
      );
      const originalControl = maintenanceControls.get(job.operationId);
      if (
        originalControl &&
        (job.operation.kind === "configurationMaintenance.settle" ||
          (job.operation.kind === "configurationMaintenance.decide" &&
            job.operation.decision === "abandon"))
      ) {
        // These accepted metadata controls retained their own bounded clock
        // under the original expired/canceled root. Lookup must authenticate
        // that SAME intent, without applying the forward-parent clamp again.
        if (requestedDeadlineAt !== job.requestedDeadlineAt)
          return reply.code(409).send(redactedOpsError(requestId, "conflict"));
        try {
          deadlineAt = normalizeConfigurationMaintenanceRecoveryControl(
            originalControl,
            job.operation,
            job.operationKey,
            job.admittedAt,
            job.deploymentBudgetMs,
          ).deadlineAt;
        } catch {
          return reply.code(409).send(redactedOpsError(requestId, "recovery_required"));
        }
      }
      if (
        executionFingerprint({
          kind: job.operation.kind,
          operationFingerprint: bodyFingerprint,
          deadlineAt,
          ...(job.parent ? { parent: job.parent } : {}),
        }) !== job.fingerprint
      )
        return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    }
    await refreshOriginalMaintenanceControl(job);
    return reply.code(200).send(opsSuccess(requestId, statusFor(job)));
  });

  app.get("/v1/operations/:operationId", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    if (!supportedPeer(request))
      return reply.code(400).send(redactedOpsError(requestId, "unsupported_peer"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsById.get(operationId);
    if (!job || job.role !== role)
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    await refreshOriginalMaintenanceControl(job);
    return reply.code(200).send(opsSuccess(requestId, statusFor(job)));
  });

  app.delete("/v1/operations/:operationId", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    if (!supportedPeer(request))
      return reply.code(400).send(redactedOpsError(requestId, "unsupported_peer"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsById.get(operationId);
    if (!job || job.role !== role)
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    if (request.headers["x-ops-operation-fingerprint"] !== job.fingerprint)
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    if (job.terminalAt !== undefined) {
      if (
        job.operation.kind === "configurationMaintenance.prepare" &&
        job.state === "failed" &&
        job.errorClass === "recovery_required" &&
        options.controlInstallation
      ) {
        try {
          const source = await recoverUnadmittedConfigurationMaintenance(
              runtime,
              restoreAdmittedControlExecution(options.controlInstallation, executionFor(job)),
            ),
            status = statusFor(job);
          const proof = signMaintenanceRecoveryProof(options.tokens.api, {
            version: 1,
            kind: "configuration-maintenance-contained",
            operationId: job.operationId,
            operationKey: job.operationKey,
            fingerprint: job.fingerprint,
            terminalDigest: controlTerminalReceiptDigest(statusFor(job)),
            ...source,
          });
          return reply.code(200).send(
            opsSuccess(requestId, {
              ...status,
              diagnostics: {
                tail: [],
                truncated: Boolean(
                  status.diagnostics?.truncated || status.diagnostics?.tail.length,
                ),
                maintenanceRecovery: proof,
              },
            }),
          );
        } catch {
          return reply.code(409).send(redactedOpsError(requestId, "recovery_required"));
        }
      }
      if (
        job.operation.kind === "artifactTransfer.import" &&
        job.state !== "succeeded" &&
        options.controlInstallation
      ) {
        let lease: ReturnType<typeof restoreArtifactTargetLeaseForSettlement> | undefined;
        try {
          const authority = restoreAdmittedControlExecution(
            options.controlInstallation,
            executionFor(job),
          );
          lease = restoreArtifactTargetLeaseForSettlement(authority);
          cancelControlExecution(authority);
          await cancelArtifactTargetLease(lease);
        } catch {
          /* Released or unverifiable roots grant no new cancellation authority. */
        } finally {
          if (lease) closeArtifactTargetLeaseHandle(lease);
        }
      }
      return reply.code(200).send(opsSuccess(requestId, statusFor(job)));
    }
    const controller = activeControllers.get(operationId);
    if (!controller) {
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    }
    try {
      await transition(job, "termination_pending", {
        terminationRequestedAt: job.terminationRequestedAt ?? now().toISOString(),
      });
    } catch {
      forceRecoveryRequired(job);
      controller.abort();
      return reply.code(500).send(redactedOpsError(requestId, "runtime"));
    }
    controller.abort();
    const settlement = activeSettlements.get(operationId);
    if (settlement) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settlement,
        new Promise<void>((resolve) => {
          waitTimer = setTimeout(resolve, 5_000);
        }),
      ]).finally(() => {
        if (waitTimer !== undefined) clearTimeout(waitTimer);
      });
    }
    return reply.code(200).send(opsSuccess(requestId, statusFor(job)));
  });

  app.get("/v1/operations/:operationId/events", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    const query = request.query as { after?: unknown; limit?: unknown };
    const after = Number(query.after ?? 0);
    const limit = Number(query.limit ?? OPS_MAX_EVENT_BATCH);
    if (
      typeof operationId !== "string" ||
      !OPERATION_ID_PATTERN.test(operationId) ||
      !Number.isInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > OPS_MAX_EVENT_BATCH
    ) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsById.get(operationId);
    if (!job || job.role !== role) {
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    }
    const events = job.events.filter((event) => event.cursor > after).slice(0, limit);
    return reply.code(200).send(
      opsSuccess(requestId, {
        version: 1,
        operationId,
        nextCursor: events.at(-1)?.cursor ?? after,
        terminal:
          job.terminalAt !== undefined && !configurationResultsSettling.has(job.operationId),
        truncated: job.eventsTruncated,
        events,
      }),
    );
  });
  if (options.artifactTransfers) registerArtifactTransferLifecycle(app, options.artifactTransfers);
  return app;
}
