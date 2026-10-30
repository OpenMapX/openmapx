import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  acknowledgeControlRetention,
  acquireArtifactTargetLease,
  assertArtifactTargetLeaseExecution,
  assertArtifactTargetLeaseForward,
  assertFreshControlRoot,
  beginControlEffect,
  bindBorrowedControlExecution,
  type ControlInstallation,
  cancelArtifactTargetLease,
  cancelControlExecution,
  closeArtifactTargetLeaseHandle,
  commitFeedProxyValidationFailure,
  completeControlJournalExecution,
  controlInstallationDataRoot,
  controlRegisteredServiceIds,
  inspectConfigurationPreEffectRefusal,
  inspectControlAdmission,
  inspectFeedProxyValidationFailure,
  isFixedSingleDataCommand,
  markFeedProxyReloadAttempted,
  planFixedSingleDataCommand,
  publishConfigurationSettlementReservationProjection,
  controlHeaders as readControlHeaders,
  reconcileConfigurationPreEffectRoot,
  reconcileControlRetention,
  registerControlRetentionJournal,
  releaseArtifactTargetLease,
  repairControlJournalTerminal,
  requireControlJournalRetention,
  reserveFeedProxyValidation,
  restoreAdmittedControlExecution,
  restoreConfigurationPreEffectTerminal,
  retainAdmittedControlExecution,
  retainConfigurationPreEffectRefusal,
  retainControlEffectReceipt,
  retainControlPreparedTerminal,
  retainControlTerminalCommitment,
  retainControlTerminalStatus,
  retainDataUpdatePlan,
  retainedControlAdoptionAssertion,
  retainFixedServiceLifecyclePlan,
  retainFixedSingleDataPlan,
  retainGenerationHardlinksOwnerPlan,
  settleArtifactTargetLeaseChild,
  type TargetLeaseAuthority,
  type VerifiedExecutionAuthority,
  verifyControlEffectSettlement,
  verifyRetainedArtifactTargetRootRelease,
  verifyRetainedArtifactTargetSettlement,
} from "@openmapx/core/build-artifacts";
import {
  type ConfigurationApplyResult,
  canonicalJson,
  configurationApplyResultSchema,
  configurationMaintenanceReceiptSchema,
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
  type VerifiedParentExecution,
  verifyApiJobParentExecution,
} from "@openmapx/core/ops";
import Fastify, { type FastifyInstance } from "fastify";
import { inspectConfigurationGenerationNonCommit } from "../../../packages/core/src/build-artifacts/control-authority";
import { ArtifactTransferError } from "./artifact-transfer/errors";
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
  acknowledgeConfigurationMaintenanceControl,
  acknowledgeConfigurationMaintenanceStep,
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
  registerConfigurationMaintenanceJournal,
  restoreConfigurationMaintenanceControlJournal,
  retainConfigurationMaintenanceDecisionControl,
  retainConfigurationMaintenanceSettleControl,
  retainOwnedConfigurationMaintenance,
} from "./configuration-maintenance-store";
import {
  installCoordinatorStagedOwnershipSource,
  prepareCoordinatorStagedRetention,
} from "./coordinator-staged-ownership";
import { prepareDataUpdateAdmission, resolveDataDefaultRegion } from "./data-workflow-runtime";
import {
  type DawarichSubjectExportRouteOptions,
  registerDawarichSubjectExportRoute,
} from "./dawarich-subject-export";
import type { HistoricalPullJob, OpsJobJournal, PersistedOpsJob } from "./journal";
import {
  type CoordinatorPullOwnershipObservation,
  consumeCoordinatorPullOwnershipCapture,
} from "./owned-services";
import { createPolicyResourceClaimer, type OpsResourceClaimer } from "./policy";
import {
  type PrivacyBackupExtractionRouteOptions,
  registerPrivacyBackupExtractionRoute,
} from "./privacy-backup-extraction";
import { safeProcessDiagnostic } from "./process-output";
import { productionOwnedServices } from "./production-runtime";
import {
  createUnavailableRuntime,
  dispatchOpsOperation,
  OpsAgentBusyError,
  type OpsExecutionContext,
  OpsExecutionFailure,
  OpsHostUpdateRequiredError,
  OpsNotWiredError,
  type OpsRuntime,
  type OpsTrustedClaim,
} from "./runtime";
import { prepareServiceUpdateAdmission } from "./service-lifecycle-runtime";
import { prepareCoordinatorPullBaseline } from "./service-pull-runtime";

import {
  type VerifiedTerminalClaimCleanup,
  verifiesTerminalClaimCleanup,
} from "./trusted-config-source";

const DEFAULT_BODY_LIMIT = 32 * 1024;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_REPLAY_ENTRIES = 10_000;
const DEFAULT_JOB_ENTRIES = 256;
const DEFAULT_JOB_RETENTION_MS = 60 * 60_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 15_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 5_000;
const MAX_JOB_ID_ATTEMPTS = 8;
const MAX_RETAINED_EVENTS_PER_JOB = 64;
const MAX_RETAINED_EVENT_BYTES_PER_JOB = 32 * 1024;
export const OPS_AGENT_RETENTION_LIMITS = {
  maxJobs: DEFAULT_JOB_ENTRIES,
  maxEventsPerJob: MAX_RETAINED_EVENTS_PER_JOB,
  maxEventBytesPerJob: MAX_RETAINED_EVENT_BYTES_PER_JOB,
  maxResultBytesPerJob: OPS_MAX_RESULT_BYTES,
  maxAggregateJournalBytes: 24 * 1024 * 1024,
  maxAggregateEventBytes: DEFAULT_JOB_ENTRIES * MAX_RETAINED_EVENT_BYTES_PER_JOB,
} as const;
// Conservative read-only surface while a retained release transaction needs reconciliation.
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
  "appApi.runtime.inspect",
  "agent.handoff.inspect",
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
}

export interface BuildOpsAgentServerOptions {
  artifactTransfers?: ArtifactTransferStore;
  controlInstallation?: ControlInstallation;
  terminalClaimCleanup?: VerifiedTerminalClaimCleanup;
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
  /**
   * True while the agent is being replaced. New asynchronous operations are
   * refused as busy, because recreating the agent would end them.
   */
  replacementInProgress?: () => boolean;
  /** Dedicated streaming managed-Dawarich collector; absent in minimal/dev agents. */
  dawarichExport?: Omit<DawarichSubjectExportRouteOptions, "apiToken">;
  /** Dedicated case-scoped backup extraction; absent in minimal agents. */
  privacyBackupExtraction?: Omit<PrivacyBackupExtractionRouteOptions, "apiToken">;
  privacyBackupHealth?: () => Promise<{
    ready: boolean;
    inventoryReadable: boolean;
    collectorImage: string | null;
  }>;
}

interface JobRecord extends Omit<PersistedOpsJob, "terminalAt"> {
  role: OpsRole;
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
  ) {
    super(errorClass);
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
  if (options.tokens.api === options.tokens["data-manager"]) {
    throw new Error("Ops agent caller credentials must be distinct");
  }
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    requestTimeout: 0,
    connectionTimeout: DEFAULT_ADMISSION_TIMEOUT_MS,
  });
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
  if (options.privacyBackupExtraction) {
    registerPrivacyBackupExtractionRoute(app, {
      ...options.privacyBackupExtraction,
      apiToken: options.tokens.api,
    });
  }
  if (options.artifactTransfers)
    registerArtifactTransferRoutes(app, {
      store: options.artifactTransfers,
      apiToken: options.tokens.api,
      admissionsOpen: () =>
        !options.replacementInProgress?.() &&
        configurationHandoffPendingMaintenanceIds(runtime).size === 0,
    });
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
  const historicalPulls = journal.historicalPullRecords?.() ?? [];
  const historicalStatus = (job: HistoricalPullJob, version: 1 | 2): OpsJobStatus => ({
    version: version === 2 && job.executionVersion === 2 ? 2 : 1,
    ...(version === 2 && job.executionVersion === 2
      ? {
          admittedAt: job.admittedAt,
          deadlineAt: job.deadlineAt,
          fingerprint: job.fingerprint,
          ...(job.diagnostics ? { diagnostics: job.diagnostics } : {}),
          ...(job.failureResult ? { failureResult: job.failureResult } : {}),
        }
      : {}),
    operationId: job.operationId,
    operationKey: job.operationKey,
    kind: "service.pull",
    resourceId: job.resourceId,
    state: job.state,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.errorClass ? { errorClass: job.errorClass } : {}),
    ...(job.terminationRequestedAt ? { terminationRequestedAt: job.terminationRequestedAt } : {}),
  });
  const resourceClaimer =
    options.resourceClaimer ?? createPolicyResourceClaimer(options.resourcePolicy ?? {});
  const jobsById = new Map<string, JobRecord>();
  const jobsByKey = new Map<string, JobRecord>();
  const activeControllers = new Map<string, AbortController>();
  const activeSettlements = new Map<string, Promise<void>>();
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
  if (restoredRecords.length + historicalPulls.length > maxJobEntries) {
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
    ...(job.executionVersion === 2
      ? {
          executionVersion: 2 as const,
          requestVersion: job.requestVersion,
          admittedAt: job.admittedAt,
          deadlineAt: job.deadlineAt,
          operationFingerprint: job.operationFingerprint,
          requestedDeadlineAt: job.requestedDeadlineAt,
          deploymentBudgetMs: job.deploymentBudgetMs,
          parent: job.parent,
        }
      : {}),
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

  const pruneJobs = async (nowMs: number) => {
    await withAdmissionLock(async () => {
      const retained = [...jobsById.values()].filter(
        (job) =>
          (job.state === "failed" && job.errorClass === "recovery_required") ||
          configurationResultsSettling.has(job.operationId) ||
          job.terminalAt === undefined ||
          (options.controlInstallation && opsKindRequiresControlAuthority(job.operation.kind)) ||
          job.terminalAt + jobRetentionMs > nowMs,
      );
      if (retained.length === jobsById.size) return;
      await journal.replace(retained.map(persisted));
      for (const [id, job] of jobsById) {
        if (
          !(job.state === "failed" && job.errorClass === "recovery_required") &&
          !configurationResultsSettling.has(job.operationId) &&
          !(options.controlInstallation && opsKindRequiresControlAuthority(job.operation.kind)) &&
          job.terminalAt !== undefined &&
          job.terminalAt + jobRetentionMs <= nowMs
        ) {
          jobsById.delete(id);
          jobsByKey.delete(`${job.role}:${job.operationKey}`);
        }
      }
    });
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
        if (!originalGenerationNonCommit && !unstartedConfiguration)
          retainControlEffectReceipt(authority, {
            outcome: committed ? "committed" : validationFailure ? "contained" : "unknown",
            publication: committed ? "committed" : validationFailure ? "not_started" : "unknown",
            receipt: committed
              ? { kind: "ops-result", result: updates.result }
              : validationFailure
                ? { kind: "feed-proxy-validation-failure", commitmentDigest: validationFailure }
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
              verifyRetainedArtifactTargetRootRelease(authority);
              // Classify only this freshly proved, fully released no-guard
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
          if (lease.mode === "owner" && committed) await releaseArtifactTargetLease(lease);
          if (lease.mode === "owner" && unstartedConfiguration) releaseUnstartedRoot = true;
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
      const candidate: JobRecord = { ...job, ...updates, state, updatedAt };
      if (["succeeded", "failed", "timed_out"].includes(state)) delete candidate.progressResult;
      if (state === "succeeded" && job.operation.kind === "services.buildAll")
        delete candidate.failureResult;
      if (authority && ["succeeded", "failed", "timed_out"].includes(state)) {
        if (candidate.terminalAt === undefined) throw Error("Missing terminal time");
        candidate.terminalAt = retainControlTerminalCommitment(
          authority,
          statusFor(candidate, 2, true),
          candidate.terminalAt,
        );
        updates = { ...updates, terminalAt: candidate.terminalAt };
      }
      if (releaseUnstartedRoot && lease?.mode === "owner" && authority) {
        await releaseArtifactTargetLease(lease);
        verifyRetainedArtifactTargetRootRelease(authority);
      }
      await journal.replace(
        [...jobsById.values()].map((entry) => persisted(entry === job ? candidate : entry)),
      );
      if (
        authority &&
        state === "succeeded" &&
        (job.operation.kind === "configurationMaintenance.prepare" ||
          job.operation.kind === "configurationHandoff.prepare")
      )
        retainControlPreparedTerminal(authority);
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

  const identityFor = (job: JobRecord) =>
    job.executionVersion === 2
      ? { admittedAt: job.admittedAt, deadlineAt: job.deadlineAt, fingerprint: job.fingerprint }
      : {};
  const executionFor = (job: JobRecord): ExecutionRef =>
    Object.freeze({
      executor: "ops-agent",
      principal: job.role,
      executionId: job.operationId,
      operationKey: job.operationKey,
      operationFingerprint: job.operationFingerprint ?? job.fingerprint,
      fingerprint: job.fingerprint,
      // Compatibility records never resume a forward execution or gain a new budget.
      deadlineAt: job.deadlineAt ?? Date.parse(job.submittedAt),
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

  const projectionVersion = (request: { headers: Record<string, unknown> }): 1 | 2 =>
    request.headers["x-ops-protocol-version"] === "2" ? 2 : 1;
  const admissionFor = (job: JobRecord, version: 1 | 2) => ({
    execution: "async",
    operationId: job.operationId,
    operationKey: job.operationKey,
    kind: job.operation.kind,
    state: outwardStateFor(job),
    ...(version === 2 && job.executionVersion === 2 ? { version: 2, ...identityFor(job) } : {}),
  });
  const statusFor = (job: JobRecord, version: 1 | 2, internalTerminal = false): OpsJobStatus => ({
    version: version === 2 && job.executionVersion === 2 ? 2 : 1,
    ...(version === 2 && job.executionVersion === 2 ? identityFor(job) : {}),
    ...(version === 2 && job.executionVersion === 2 && job.diagnostics
      ? { diagnostics: job.diagnostics }
      : {}),
    ...(version === 2 && job.executionVersion === 2 && job.failureResult
      ? { failureResult: job.failureResult }
      : {}),
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

  const unregisterRetention = options.controlInstallation
    ? registerControlRetentionJournal(options.controlInstallation, {
        ...(literalProductionRuntime && options.journal
          ? {
              prepare: async (
                _executions: readonly { execution: ExecutionRef; digest?: string }[],
                context?: import("@openmapx/core/build-artifacts").ControlRetentionPreparationContext,
              ) =>
                withAdmissionLock(async () => {
                  if (!context) throw Error("Actual collector preparation required");
                  await prepareCoordinatorStagedRetention(
                    context,
                    runtime,
                    options.controlInstallation!,
                    journal,
                  );
                }),
            }
          : {}),
        contained: (execution, digest) => {
          const job = jobsById.get(execution.executionId);
          return (
            !!job &&
            !activeControllers.has(job.operationId) &&
            ["succeeded", "failed", "timed_out"].includes(job.state) &&
            !!digest &&
            controlTerminalReceiptDigest(statusFor(job, 2)) === digest
          );
        },
        retire: async (executions, _manifestDigest) =>
          withAdmissionLock(async () => {
            const remove = new Set<string>();
            for (const { execution, digest } of executions) {
              const job = jobsById.get(execution.executionId);
              if (!job) continue;
              if (
                activeControllers.has(job.operationId) ||
                job.operationKey !== execution.operationKey ||
                job.fingerprint !== execution.fingerprint ||
                controlTerminalReceiptDigest(statusFor(job, 2)) !== digest
              )
                throw Error("Agent terminal journal changed during retirement");
              remove.add(job.operationId);
            }
            // These two metadata controls deliberately have no ordinary
            // execution/family node. Retire their secondary projections only
            // with the original root's committed all-role retirement. Private
            // owner cleanup has already happened at this point; startup must
            // continue to reject an orphan outside this cleanup capability.
            for (const job of jobsById.values()) {
              const body = job.operation;
              if (
                body.kind !== "configurationMaintenance.decide" &&
                body.kind !== "configurationMaintenance.settle"
              )
                continue;
              const original = executions.find(
                ({ execution }) => execution.operationKey === body.prepareOperationKey,
              );
              if (!original) continue;
              const receipt = configurationMaintenanceReceiptSchema.parse(job.result),
                parent = job.parent;
              if (
                activeControllers.has(job.operationId) ||
                job.state !== "succeeded" ||
                job.terminalAt === undefined ||
                job.role !== "api" ||
                job.executionVersion !== 2 ||
                parent?.issuer !== "api" ||
                canonicalJson(receipt.prepare) !== canonicalJson(original.execution) ||
                original.execution.operationFingerprint !== body.prepareFingerprint ||
                receipt.binding.maintenanceId !== body.maintenanceId ||
                receipt.binding.candidateId !== body.candidateId ||
                receipt.planDigest !== body.planDigest ||
                receipt.decision?.decisionId !== body.decisionId ||
                receipt.apiJobId !== parent.apiJobId ||
                receipt.parentOperationKey !== parent.operationKey ||
                receipt.parentFingerprint !== parent.fingerprint ||
                receipt.parentDeadlineAt !== parent.deadlineAt ||
                (body.kind === "configurationMaintenance.decide" &&
                  (receipt.decision.decision !== body.decision ||
                    receipt.decision.checkpointVersion !== body.checkpointVersion ||
                    receipt.decision.checkpointDigest !== body.checkpointDigest)) ||
                (body.kind === "configurationMaintenance.settle" &&
                  (receipt.state !== "settled" || receipt.dmFence?.state !== "settled"))
              )
                throw Error("Agent maintenance control journal changed during retirement");
              remove.add(job.operationId);
            }
            await journal.replace(
              [...jobsById.values()].filter((job) => !remove.has(job.operationId)).map(persisted),
            );
            for (const id of remove) {
              const job = jobsById.get(id);
              if (!job) throw Error("Missing retiring operation journal");
              jobsById.delete(id);
              jobsByKey.delete(`${job.role}:${job.operationKey}`);
              controlAuthorities.delete(id);
            }
          }),
      })
    : undefined;
  app.addHook("onClose", async () => {
    unregisterRetention?.();
  });
  const runAsync = async (
    job: JobRecord,
    startedAt: number,
    claim: OpsExecutionContext["claim"],
    claimAdmission: OpsTrustedClaim["admission"],
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
    let claimReleased = !claimAdmission;
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
          if (authority && job.operation.kind === "service.image.stage") {
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
              // Persist commit evidence before releasing confidential claim data.
              // Public status remains running until cleanup evidence is settled.
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
              try {
                await claimAdmission?.release();
                claimReleased = true;
              } catch {
                claimReleased = false;
                configurationEvidence = { ...result, cleanupFailed: true };
                await transition(job, "succeeded", {
                  result: configurationEvidence,
                  errorClass: undefined,
                  terminalAt: now().getTime(),
                });
              }
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
              job.role === "data-manager" &&
              [
                "motis.primary.stop",
                "motis.staging.stop",
                "motis.staging.restart",
                "motis.primary.restart",
                "motis.primary.promote",
                "feedProxy.validateAndReload",
                "transitousLock.approve",
              ].includes(job.operation.kind)
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
            if (configurationResultsSettling.delete(job.operationId) && job.state === "succeeded") {
              job.cursor += 1;
              pushEvent(job, { cursor: job.cursor, type: "state", state: "succeeded" });
            }
            if (terminalDurable && !claimReleased && !configurationEvidence) {
              await claimAdmission
                ?.release()
                .then(() => {
                  claimReleased = true;
                })
                .catch(async () => {
                  stickyRecoveryRequired.add(job.operationId);
                  await transition(job, "failed", {
                    result: undefined,
                    errorClass: "recovery_required",
                    terminalAt: now().getTime(),
                  }).catch(() => forceRecoveryRequired(job));
                });
            }
            const authority = controlAuthorities.get(job.operationId);
            if (terminalDurable && authority && options.controlInstallation)
              retainControlTerminalStatus(
                options.controlInstallation,
                authority.execution,
                statusFor(job, 2),
                job.terminalAt,
              );
            if (terminalDurable && claimReleased && authority)
              completeControlJournalExecution(authority);
            if (
              terminalDurable &&
              claimReleased &&
              authority &&
              options.controlInstallation &&
              job.terminalAt !== undefined &&
              job.state === "succeeded" &&
              (isTrustedConfigurationApplyOperation(job.operation) ||
                job.operation.kind === "configuration.hardlinks.apply" ||
                job.operation.kind === "configurationHandoff.prepare" ||
                job.operation.kind === "service.recreate" ||
                job.operation.kind === "service.recreateIsolated") &&
              job.operation.maintenanceId
            ) {
              try {
                recordOwnedConfigurationMaintenanceStepTerminal(
                  options.controlInstallation,
                  job.operation,
                  executionFor(job),
                  statusFor(job, 2),
                  job.terminalAt,
                );
              } catch {
                stickyRecoveryRequired.add(
                  job.operationId,
                ); /* Exact ACK publication may repair this committed source; no target replay. */
              }
            }
            activeControllers.delete(job.operationId);
            active -= 1;
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
            if (terminalDurable && !claimReleased) {
              await claimAdmission
                ?.release()
                .then(() => {
                  claimReleased = true;
                })
                .catch(async () => {
                  stickyRecoveryRequired.add(job.operationId);
                  await transition(job, "failed", {
                    result: undefined,
                    errorClass: "recovery_required",
                    terminalAt: now().getTime(),
                  }).catch(() => forceRecoveryRequired(job));
                });
            }
            const authority = controlAuthorities.get(job.operationId);
            if (terminalDurable && authority && options.controlInstallation)
              retainControlTerminalStatus(
                options.controlInstallation,
                authority.execution,
                statusFor(job, 2),
                job.terminalAt,
              );
            if (terminalDurable && claimReleased && authority)
              completeControlJournalExecution(authority);
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
    const statusCode = (error as { statusCode?: number }).statusCode === 413 ? 413 : 400;
    return reply
      .code(statusCode)
      .send(redactedOpsError(requestIdFromBody(request.body), "validation", error));
  });
  app.get("/v1/protocol", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    if (!resolveRole(request.headers.authorization, options.tokens))
      return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    return reply.send(opsSuccess(requestId, { versions: [1, 2] }));
  });
  app.get("/health", async () => {
    let privacyBackup = {
      ready: false,
      inventoryReadable: false,
      collectorImage: null as string | null,
    };
    try {
      privacyBackup = (await options.privacyBackupHealth?.()) ?? privacyBackup;
    } catch {
      // Health evidence is fail-closed and never includes Docker/inventory errors.
    }
    return {
      ok: true,
      privacyBackup,
      ...(options.releaseRecovery ? { releaseRecovery: options.releaseRecovery } : {}),
    };
  });

  // No replay during restart. Rejoin original signed admissions/adoptions and
  // retained own-effect proof; absent containment evidence keeps its fence.
  app.addHook("onReady", async () => {
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
        } else if (next.size >= maxJobEntries)
          throw Error("Original maintenance control recovery capacity exceeded");
        const restored: JobRecord = {
          ...source,
          terminalAt: source.terminalAt === undefined ? undefined : Date.parse(source.terminalAt),
          cursor: prior?.cursor ?? 0,
          events: prior?.events ?? [],
          eventBytes: prior?.eventBytes ?? 0,
          eventsTruncated: true,
        };
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
                // A previously sealed, different canonical tuple refuses here;
                // an unknown secondary journal never overrides that source.
                restored.terminalAt = retainControlTerminalCommitment(
                  authority,
                  statusFor(restored, 2, true),
                  published.terminalAt,
                );
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
      if (
        job.executionVersion === 2 &&
        job.operation.kind !== "configurationMaintenance.decide" &&
        job.operation.kind !== "configurationMaintenance.settle" &&
        opsKindRequiresControlAuthority(job.operation.kind) &&
        ["succeeded", "failed", "timed_out"].includes(job.state)
      ) {
        try {
          if (!options.controlInstallation || job.terminalAt === undefined)
            throw Error("Original terminal authority unavailable");
          if (
            isTrustedConfigurationApplyOperation(job.operation) &&
            !verifiesTerminalClaimCleanup(
              options.terminalClaimCleanup,
              job.operation,
              new Date(job.terminalAt).toISOString(),
            )
          )
            throw Error("Terminal claim cleanup is not proved");
          const execution = executionFor(job);
          if (
            literalProductionRuntime &&
            job.state === "failed" &&
            ["configuration_prerequisite", "busy", "recovery_required"].includes(
              job.errorClass ?? "",
            ) &&
            (job.operation.kind === "service.update" ||
              job.operation.kind === "stack.start" ||
              (job.operation.kind === "service.start" &&
                job.operation.serviceId !== "data-manager") ||
              (job.operation.kind === "service.pull" &&
                job.operation.serviceId === "data-manager" &&
                job.operation.candidateId))
          ) {
            const recovered = restoreConfigurationPreEffectTerminal(
                options.controlInstallation,
                execution,
                statusFor(job, 2),
              ),
              authority = repairControlJournalTerminal(
                options.controlInstallation,
                execution,
                recovered.status,
                recovered.terminalAt,
              ),
              restored: JobRecord = {
                ...job,
                state: "failed",
                result: undefined,
                errorClass: recovered.status.errorClass,
                failureResult: recovered.status.failureResult,
                terminationRequestedAt: recovered.status.terminationRequestedAt,
                terminalAt: recovered.terminalAt,
                updatedAt: recovered.status.updatedAt,
              };
            // Retain the exact original body before finishing its physical
            // release. A failed/unknown write cannot create a fresh attempt.
            await journal.replace(
              [...jobsById.values()].map((value) => persisted(value === job ? restored : value)),
            );
            await reconcileConfigurationPreEffectRoot(authority);
            Object.assign(job, restored);
            controlAuthorities.set(job.operationId, authority);
            continue;
          }
          if (job.controlAdoption)
            verifyRetainedArtifactTargetSettlement(
              options.controlInstallation,
              job.controlAdoption,
              execution,
            );
          const authority = repairControlJournalTerminal(
            options.controlInstallation,
            execution,
            statusFor(job, 2),
            job.terminalAt,
          );
          controlAuthorities.set(job.operationId, authority);
        } catch {
          // The loaded terminal state, elapsed time and absence of a PID never
          // prove containment. Keep its exact outcome and original time intact.
          stickyRecoveryRequired.add(job.operationId);
        }
      }
    }
    if (changed) await journal.replace([...jobsById.values()].map(persisted));
    if (options.controlInstallation)
      await reconcileControlRetention(options.controlInstallation).catch(() => undefined);
  });

  app.post(
    "/v1/operations",
    { bodyLimit: options.bodyLimit ?? 772 * 1024 },
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
          parsed.operation.kind === "transitousLock.propose"
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
        const policy = OPS_KIND_POLICIES[operation.kind];
        // Read-only historical records can neither reserve a fresh normal key
        // nor turn an unresolved old effect into permission for another writer.
        if (
          historicalPulls.some(
            (job) => job.role === role && job.operationKey === parsed.operationKey,
          )
        )
          throw new RequestGuardError("conflict", 409);
        if (
          opsKindRequiresControlAuthority(operation.kind) &&
          historicalPulls.some(
            (job) =>
              ["queued", "running", "termination_pending"].includes(job.state) ||
              job.errorClass === "recovery_required",
          )
        )
          throw new RequestGuardError("recovery_required", 409);
        const operationFingerprint = opsOperationFingerprint(operation);
        if (operation.kind === "controlRetention.acknowledge") {
          if (role !== "api" || !options.controlInstallation)
            throw new RequestGuardError("authorization", 403);
          try {
            const existing = jobsByKey.get(`api:${operation.operationKey}`);
            if (
              existing &&
              controlTerminalReceiptDigest(statusFor(existing, 2)) !== operation.terminalDigest
            )
              throw Error("Current terminal digest conflict");
            const phase =
              existing &&
              (isTrustedConfigurationApplyOperation(existing.operation) ||
                existing.operation.kind === "configuration.hardlinks.apply" ||
                existing.operation.kind === "configurationHandoff.prepare" ||
                existing.operation.kind === "service.recreate" ||
                existing.operation.kind === "service.recreateIsolated") &&
              existing.operation.maintenanceId;
            if (phase && existing.terminalAt !== undefined)
              recordOwnedConfigurationMaintenanceStepTerminal(
                options.controlInstallation,
                existing.operation,
                executionFor(existing),
                statusFor(existing, 2),
                existing.terminalAt,
              );
            const value = phase
              ? acknowledgeConfigurationMaintenanceStep(
                  options.controlInstallation,
                  operation,
                  options.tokens.api,
                )
              : operation.originRootKey !== operation.operationKey &&
                  (existing?.operation.kind === "configurationMaintenance.decide" ||
                    existing?.operation.kind === "configurationMaintenance.settle")
                ? acknowledgeConfigurationMaintenanceControl(
                    options.controlInstallation,
                    operation,
                    options.tokens.api,
                  )
                : acknowledgeControlRetention(
                    options.controlInstallation,
                    operation,
                    options.tokens.api,
                  );
            return reply
              .code(200)
              .send(
                opsSuccess(parsed.requestId, { execution: "sync", kind: operation.kind, value }),
              );
          } catch {
            throw new RequestGuardError("recovery_required", 409);
          }
        }
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
          if (
            !options.controlInstallation ||
            role !== "data-manager" ||
            parsed.version !== 2 ||
            parentHeader !== undefined
          )
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
        if (parsed.version === 1 && (parentHeader !== undefined || delegationHeader !== undefined))
          throw new RequestGuardError("authorization", 403);
        if (parentHeader !== undefined) {
          if (role !== "api" || typeof parentHeader !== "string")
            throw new RequestGuardError("authorization", 403);
          try {
            parent = verifyApiJobParentExecution(parentHeader, options.tokens.api, {
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
            return job.executionVersion === 2
              ? job.fingerprint ===
                  normalize(job.admittedAt as number, job.deploymentBudgetMs).fingerprint
              : job.fingerprint === operationFingerprint &&
                  parsed.execution === undefined &&
                  !parent;
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
            return reply
              .code(202)
              .send(opsSuccess(parsed.requestId, admissionFor(existing, parsed.version)));
          }
          if (options.controlInstallation) {
            try {
              await reconcileControlRetention(options.controlInstallation, { maxFamilies: 1 });
            } catch {
              throw new RequestGuardError("recovery_required", 409);
            }
          }
          if (jobsById.size + historicalPulls.length >= maxJobEntries) {
            throw new RequestGuardError("busy", 429);
          }
          // A resumed agent update re-attaches above; nothing new may start.
          if (
            operation.kind !== "agent.update" &&
            options.replacementInProgress?.() &&
            configurationHandoffPendingMaintenanceIds(runtime).size === 0
          ) {
            throw new RequestGuardError("busy", 409);
          }
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
            throw new RequestGuardError("control_upgrade_required", 409);
          }
          try {
            assertFreshControlRoot(
              options.controlInstallation,
              parsed.operationKey,
              parsed.execution?.requestedDeadlineAt,
            );
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
                void lateClaim?.admission?.rollback().catch(() => undefined);
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
        let claimAdmission: OpsTrustedClaim["admission"];
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
          claimAdmission = claim.admission;
          claim = immutableSnapshot({
            fingerprint: claim.fingerprint,
            operation: claim.operation,
            source: claim.source,
            capability: claim.capability,
          });
        } catch {
          await claim?.admission?.rollback().catch(() => undefined);
          active -= 1;
          throw new OpsContractError("authorization", "Operation resource is not permitted");
        }

        if (policy.execution === "async") {
          const ownerKey = `${role}:${parsed.operationKey}`;
          const admission = await withAdmissionLock(async () => {
            const retained = jobsByKey.get(ownerKey);
            if (retained) {
              if (!matchesRetained(retained)) {
                throw new RequestGuardError("conflict", 409);
              }
              return { type: "retained", job: retained } as const;
            }
            if (jobsById.size + historicalPulls.length >= maxJobEntries)
              throw new RequestGuardError("busy", 429);
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
                if (
                  job.admittedAt === undefined ||
                  job.requestedDeadlineAt === undefined ||
                  typeof parentHeader !== "string"
                )
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
                          AbortSignal.timeout(Math.max(1, job.deadlineAt! - Date.now())),
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
                    requestVersion: job.requestVersion!,
                    deploymentBudgetMs: job.deploymentBudgetMs!,
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
                if (
                  job.admittedAt === undefined ||
                  job.requestedDeadlineAt === undefined ||
                  typeof parentHeader !== "string"
                )
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
                    requestVersion: job.requestVersion!,
                    deploymentBudgetMs: job.deploymentBudgetMs!,
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
            await journal.replace([...jobsById.values()].map(persisted).concat(persisted(job)));
            jobsById.set(job.operationId, job);
            jobsByKey.set(ownerKey, job);
            if (
              !controlAdmission &&
              !configurationMaintenanceControl &&
              opsKindRequiresControlAuthority(operation.kind)
            ) {
              try {
                if (!options.controlInstallation || job.admittedAt === undefined)
                  throw Error("Control trust unavailable");
                const maintenanceAdmission =
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
                const maintenancePlan =
                  maintenanceAdmission &&
                  configurationMaintenanceAdmissionState(maintenanceAdmission).plan;
                const targets =
                  maintenancePlan?.serviceIds ??
                  ("serviceId" in operation &&
                  ![
                    "service.start",
                    "service.recreate",
                    "service.recreateIsolated",
                    "service.update",
                  ].includes(operation.kind)
                    ? [operation.serviceId]
                    : controlRegisteredServiceIds(options.controlInstallation));
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
                const hardlinksPlan =
                  job.operation.kind === "configuration.hardlinks.apply"
                    ? prepareConfigurationHardlinksAdmission(
                        runtime,
                        executionFor(job),
                        job.operation,
                        targets,
                      )
                    : undefined;
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
                if (lifecyclePlan) retainFixedServiceLifecyclePlan(authority, lifecyclePlan);
                requireControlJournalRetention(authority);
                controlAuthorities.set(job.operationId, authority);
                if (
                  [
                    "configurationMaintenance.prepare",
                    "stack.start",
                    "coreService.restart",
                    "service.start",
                    "service.recreate",
                    "service.recreateIsolated",
                    "service.update",
                    "configuration.hardlinks.apply",
                    "valhalla.traffic.maintain",
                    "valhalla.traffic.refreshWaysToEdges",
                  ].includes(job.operation.kind)
                ) {
                  const lease = await acquireArtifactTargetLease({
                    dataRoot: controlInstallationDataRoot(options.controlInstallation),
                    serviceIds:
                      maintenancePlan ||
                      hardlinksPlan ||
                      lifecyclePlan ||
                      [
                        "stack.start",
                        "service.start",
                        "coreService.restart",
                        "service.recreate",
                        "service.recreateIsolated",
                      ].includes(job.operation.kind)
                        ? targets
                        : ["valhalla"],
                    owner: authority,
                  });
                  controlLeases.set(job.operationId, lease);
                  if (maintenanceAdmission) {
                    retainOwnedConfigurationMaintenance(authority, lease, maintenanceAdmission);
                    publishConfigurationSettlementReservationProjection(
                      authority,
                      maintenancePlan!.operation.maintenanceId,
                    );
                  }
                }
              } catch (error) {
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
                if (!options.controlInstallation || job.admittedAt === undefined)
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
                requireControlJournalRetention(authority);
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
          }).catch(async (error) => {
            await claimAdmission?.rollback().catch(() => undefined);
            active -= 1;
            throw error instanceof RequestGuardError
              ? error
              : new RequestGuardError("runtime", 500);
          });
          if (admission.type === "retained") {
            await claimAdmission?.rollback().catch(() => undefined);
            active -= 1;
            return reply
              .code(202)
              .send(opsSuccess(parsed.requestId, admissionFor(admission.job, parsed.version)));
          }
          const { job } = admission;
          try {
            if (normalized.deadlineAt <= now().getTime())
              throw new RequestGuardError("timeout", 504);
            await claimAdmission?.commit();
          } catch {
            stickyRecoveryRequired.add(job.operationId);
            await transition(job, "failed", {
              result: undefined,
              errorClass: "recovery_required",
              terminalAt: now().getTime(),
            }).catch(() => forceRecoveryRequired(job));
            await claimAdmission?.release().catch(() => undefined);
            active -= 1;
            throw new RequestGuardError("runtime", 500);
          }
          await runAsync(job, startedAt, claim, claimAdmission);
          return reply
            .code(202)
            .send(opsSuccess(parsed.requestId, admissionFor(job, parsed.version)));
        }
        const controller = new AbortController();
        try {
          if (normalized.deadlineAt <= now().getTime()) throw new RequestGuardError("timeout", 504);
          await claimAdmission?.commit();
        } catch {
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
    const operationKey = (request.params as { operationKey?: unknown }).operationKey;
    if (typeof operationKey !== "string" || !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(operationKey)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsByKey.get(`${role}:${operationKey}`);
    if (!job) {
      const legacy = historicalPulls.find(
        (value) => value.role === role && value.operationKey === operationKey,
      );
      if (!legacy) return reply.code(404).send(redactedOpsError(requestId, "not_found"));
      const fingerprint = request.headers["x-ops-operation-fingerprint"],
        body = request.headers["x-ops-body-fingerprint"],
        requested = request.headers["x-ops-requested-deadline"];
      if (
        (body !== undefined && body !== (legacy.operationFingerprint ?? legacy.fingerprint)) ||
        ((body === undefined || fingerprint !== undefined) &&
          fingerprint !== legacy.fingerprint &&
          fingerprint !== legacy.operationFingerprint) ||
        (requested !== undefined && requested !== String(legacy.requestedDeadlineAt))
      )
        return reply.code(409).send(redactedOpsError(requestId, "conflict"));
      return reply
        .code(200)
        .send(opsSuccess(requestId, historicalStatus(legacy, projectionVersion(request))));
    }
    const fingerprint = request.headers["x-ops-operation-fingerprint"];
    const bodyFingerprint = request.headers["x-ops-body-fingerprint"];
    // Explicit compatibility: a v1 lookup used the body hash in the sole header.
    if (bodyFingerprint !== undefined) {
      if (bodyFingerprint !== (job.operationFingerprint ?? job.fingerprint))
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
          (job.admittedAt ?? 0) + (job.deploymentBudgetMs ?? 0),
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
          if (
            requestedDeadlineAt !== job.requestedDeadlineAt ||
            job.admittedAt === undefined ||
            job.deploymentBudgetMs === undefined
          )
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
            operationFingerprint: bodyFingerprint as string,
            deadlineAt,
            ...(job.parent ? { parent: job.parent } : {}),
          }) !== job.fingerprint
        )
          return reply.code(409).send(redactedOpsError(requestId, "conflict"));
      }
    } else {
      if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))
        return reply.code(400).send(redactedOpsError(requestId, "validation"));
      if (fingerprint !== job.fingerprint && fingerprint !== job.operationFingerprint)
        return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    }
    await refreshOriginalMaintenanceControl(job);
    return reply.code(200).send(opsSuccess(requestId, statusFor(job, projectionVersion(request))));
  });

  app.get("/v1/operations/:operationId", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsById.get(operationId);
    if (!job || job.role !== role) {
      const legacy = historicalPulls.find(
        (value) => value.operationId === operationId && value.role === role,
      );
      if (legacy)
        return reply
          .code(200)
          .send(opsSuccess(requestId, historicalStatus(legacy, projectionVersion(request))));
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    }
    await refreshOriginalMaintenanceControl(job);
    return reply.code(200).send(opsSuccess(requestId, statusFor(job, projectionVersion(request))));
  });

  app.delete("/v1/operations/:operationId", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsById.get(operationId);
    if (!job || job.role !== role) {
      const legacy = historicalPulls.find(
        (value) => value.operationId === operationId && value.role === role,
      );
      if (legacy) {
        if (
          legacy.executionVersion === 2 &&
          request.headers["x-ops-operation-fingerprint"] !== legacy.fingerprint
        )
          return reply.code(409).send(redactedOpsError(requestId, "conflict"));
        return legacy.terminalAt === undefined
          ? reply.code(409).send(redactedOpsError(requestId, "recovery_required"))
          : reply
              .code(200)
              .send(opsSuccess(requestId, historicalStatus(legacy, projectionVersion(request))));
      }
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    }
    if (
      job.executionVersion === 2 &&
      request.headers["x-ops-operation-fingerprint"] !== job.fingerprint &&
      !(projectionVersion(request) === 1 && job.requestVersion === 1)
    )
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    if (job.terminalAt !== undefined) {
      return reply
        .code(200)
        .send(opsSuccess(requestId, statusFor(job, projectionVersion(request))));
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
    return reply.code(200).send(opsSuccess(requestId, statusFor(job, projectionVersion(request))));
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
  return app;
}
