/** Pure retained operation decoder. It never admits a child or opens a writer. */
import {
  apiRetentionProofSchema,
  canonicalJson,
  controlTerminalReceiptDigest,
  OPS_KIND_POLICIES,
  type OpsFailureResult,
  type OpsJobStatus,
  type OpsOperation,
  type OpsOperationKind,
  opsFailureResultSchema,
  opsKindRequiresControlAuthority,
  opsOperationFingerprint,
  opsOperationSchema,
  type ProcessDiagnostics,
  parseControlRootOperationKey,
  processDiagnosticsSchema,
} from "@openmapx/core/ops";
import { JobObservationPending } from "./admin-job-failure";
import { type ApiJobChildAttempt, apiJobChildAttemptSchema } from "./admin-job-parent";
import { ADMIN_JOB_LOG_LIMITS } from "./admin-job-state";
import { assertConfigurationMaintenanceProjectedStep } from "./configuration-maintenance-step-records";

const ADMIN_EVENT_LIMIT = ADMIN_JOB_LOG_LIMITS.events;
const ADMIN_EVENT_BYTE_LIMIT = ADMIN_JOB_LOG_LIMITS.bytes;
const MAX_PROJECTED_OPERATIONS = 64;
const ADMISSION_REFUSALS = new Set([
  "authentication",
  "authorization",
  "validation",
  "expired",
  "future",
  "busy",
  "not_wired",
  "host_update_required",
  "control_upgrade_required",
  "recovery_required",
]);
const OPERATION_KEY = /^opk1_[A-Za-z0-9_-]{16,64}$/;
const OPERATION_ID = /^job1_[A-Za-z0-9_-]{16,64}$/;

export interface ProjectedOperation {
  kind: OpsOperationKind;
  operationKey: string;
  operationId?: string;
  operation?: OpsOperation;
  phase: "unissued" | "prepared" | "admitting" | "observing" | "terminal" | "refused";
  nonissuance?: { version: 1; candidateId: string; checkedOwnerVersion: number; checkedAt: number };
  attempt?: ApiJobChildAttempt;
  fingerprint?: string;
  deadlineAt?: number;
  outcome?: "unknown";
  result?: unknown;
  failureResult?: OpsFailureResult;
  diagnostics?: ProcessDiagnostics;
  errorClass?: string;
  mirrorStopped?: boolean;
  cursor: number;
  events: number;
  bytes: number;
  truncated: boolean;
  terminal: boolean;
  receiptDelivery?: {
    state: "pending" | "confirmed";
    terminalCopyId: string;
    checkpointOwnerVersion: number;
    terminalDigest: string;
    terminalReceipt: OpsJobStatus;
  };
}

export interface OpsProjection {
  version: 1 | 2 | 3;
  steps: Record<string, { operationKey: string; requestedDeadlineAt: number }>;
  eventTotal: number;
  byteTotal: number;
  truncated: boolean;
  operations: Record<string, ProjectedOperation>;
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function emptyProjection(): OpsProjection {
  return { version: 3, steps: {}, eventTotal: 0, byteTotal: 0, truncated: false, operations: {} };
}

export function readProjection(result: unknown): OpsProjection {
  if (!result || typeof result !== "object" || Array.isArray(result)) return emptyProjection();
  const candidate = (result as Record<string, unknown>).opsProjection;
  if (candidate === undefined) return emptyProjection();
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new JobObservationPending("invalid_identity");
  }
  const value = candidate as Record<string, unknown>;
  if (
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !boundedInteger(value.eventTotal, ADMIN_EVENT_LIMIT) ||
    !boundedInteger(value.byteTotal, ADMIN_EVENT_BYTE_LIMIT) ||
    typeof value.truncated !== "boolean" ||
    !value.operations ||
    typeof value.operations !== "object" ||
    Array.isArray(value.operations)
  ) {
    throw new JobObservationPending("invalid_identity");
  }
  const entries = Object.entries(value.operations as Record<string, unknown>);
  if (entries.length > MAX_PROJECTED_OPERATIONS)
    throw new JobObservationPending("invalid_identity");
  const operations: Record<string, ProjectedOperation> = {};
  for (const [key, raw] of entries) {
    if (!OPERATION_KEY.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new JobObservationPending("invalid_identity");
    }
    const operation = raw as Record<string, unknown>;
    if (
      operation.operationKey !== key ||
      (operation.operationId !== undefined &&
        (typeof operation.operationId !== "string" || !OPERATION_ID.test(operation.operationId))) ||
      (value.version === 1 && operation.operationId === undefined) ||
      typeof operation.kind !== "string" ||
      !boundedInteger(operation.cursor, Number.MAX_SAFE_INTEGER) ||
      !boundedInteger(operation.events, ADMIN_EVENT_LIMIT) ||
      !boundedInteger(operation.bytes, ADMIN_EVENT_BYTE_LIMIT) ||
      typeof operation.truncated !== "boolean" ||
      typeof operation.terminal !== "boolean"
    ) {
      throw new JobObservationPending("invalid_identity");
    }
    if (!Object.hasOwn(OPS_KIND_POLICIES, operation.kind as string))
      throw new JobObservationPending("invalid_identity");
    if (
      value.version !== 1 &&
      ![
        "admitting",
        "observing",
        "terminal",
        ...(value.version === 3 ? ["refused", "prepared", "unissued"] : []),
      ].includes(operation.phase as string)
    )
      throw new JobObservationPending("invalid_identity");
    const checked =
      operation.operation === undefined
        ? undefined
        : opsOperationSchema.safeParse(operation.operation);
    if (checked && !checked.success) throw new JobObservationPending("invalid_identity");
    const parsed = checked?.data;
    if (
      operation.phase === "prepared" &&
      (parsed?.kind !== "service.pull" ||
        !parsed.candidateId ||
        parsed.serviceId !== "data-manager" ||
        !operation.attempt ||
        operation.terminal ||
        operation.operationId !== undefined ||
        operation.fingerprint !== undefined ||
        operation.deadlineAt !== undefined ||
        operation.result !== undefined ||
        operation.receiptDelivery !== undefined)
    )
      throw new JobObservationPending("invalid_identity");
    if (operation.phase === "unissued") {
      const closed = operation.nonissuance as ProjectedOperation["nonissuance"];
      if (
        parsed?.kind !== "service.pull" ||
        parsed.serviceId !== "data-manager" ||
        !parsed.candidateId ||
        !operation.attempt ||
        operation.terminal !== true ||
        operation.operationId !== undefined ||
        operation.fingerprint !== undefined ||
        operation.deadlineAt !== undefined ||
        operation.result !== undefined ||
        operation.failureResult !== undefined ||
        operation.diagnostics !== undefined ||
        operation.errorClass !== undefined ||
        operation.receiptDelivery !== undefined ||
        operation.outcome !== undefined ||
        operation.cursor !== 0 ||
        operation.events !== 0 ||
        operation.bytes !== 0 ||
        operation.truncated ||
        !closed ||
        Object.keys(closed).length !== 4 ||
        closed.version !== 1 ||
        closed.candidateId !== parsed.candidateId ||
        !Number.isSafeInteger(closed.checkedOwnerVersion) ||
        closed.checkedOwnerVersion < 1 ||
        !Number.isSafeInteger(closed.checkedAt) ||
        closed.checkedAt < 0
      )
        throw new JobObservationPending("invalid_identity");
    } else if (operation.nonissuance !== undefined)
      throw new JobObservationPending("invalid_identity");
    if (
      operation.fingerprint !== undefined &&
      (typeof operation.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(operation.fingerprint))
    )
      throw new JobObservationPending("invalid_identity");
    if (
      operation.deadlineAt !== undefined &&
      !boundedInteger(operation.deadlineAt, Number.MAX_SAFE_INTEGER)
    )
      throw new JobObservationPending("invalid_identity");
    if (
      operation.failureResult !== undefined &&
      !opsFailureResultSchema.safeParse(operation.failureResult).success
    )
      throw new JobObservationPending("invalid_identity");
    if (
      operation.diagnostics !== undefined &&
      !processDiagnosticsSchema.safeParse(operation.diagnostics).success
    )
      throw new JobObservationPending("invalid_identity");
    if (operation.attempt !== undefined) {
      const attempt = apiJobChildAttemptSchema.safeParse(operation.attempt);
      if (
        !attempt.success ||
        (operation.phase === "unissued" &&
          (operation.nonissuance as ProjectedOperation["nonissuance"])!.checkedOwnerVersion <
            attempt.data.apiOwnerVersion) ||
        !parsed ||
        attempt.data.childOperationKey !== key ||
        attempt.data.childOperationFingerprint !== opsOperationFingerprint(parsed)
      )
        throw new JobObservationPending("invalid_identity");
    }
    if (
      operation.phase === "refused" &&
      (!operation.terminal ||
        !ADMISSION_REFUSALS.has(operation.errorClass as string) ||
        operation.operationId !== undefined ||
        operation.result !== undefined ||
        operation.receiptDelivery !== undefined ||
        operation.fingerprint !== undefined ||
        operation.deadlineAt !== undefined)
    )
      throw new JobObservationPending("invalid_identity");
    if (operation.receiptDelivery !== undefined) {
      const d = operation.receiptDelivery as ProjectedOperation["receiptDelivery"];
      try {
        if (
          value.version !== 3 ||
          !operation.attempt ||
          operation.terminal !== true ||
          operation.phase !== "terminal" ||
          !d ||
          !["pending", "confirmed"].includes(d.state) ||
          !apiRetentionProofSchema.shape.terminalCopyId.safeParse(d.terminalCopyId).success ||
          !Number.isSafeInteger(d.checkpointOwnerVersion) ||
          d.checkpointOwnerVersion < 1 ||
          controlTerminalReceiptDigest(d.terminalReceipt) !== d.terminalDigest ||
          d.terminalReceipt.operationId !== operation.operationId ||
          d.terminalReceipt.kind !== operation.kind ||
          d.terminalReceipt.operationKey !== key ||
          canonicalJson(d.terminalReceipt.result ?? null) !==
            canonicalJson(operation.result ?? null) ||
          canonicalJson(d.terminalReceipt.failureResult ?? null) !==
            canonicalJson(operation.failureResult ?? null) ||
          (d.terminalReceipt.errorClass ?? null) !== (operation.errorClass ?? null) ||
          d.terminalReceipt.fingerprint !== operation.fingerprint ||
          d.terminalReceipt.deadlineAt !== operation.deadlineAt
        )
          throw Error();
      } catch {
        throw new JobObservationPending("recovery_required");
      }
    }
    if (parsed && parsed.kind !== operation.kind)
      throw new JobObservationPending("invalid_identity");
    operations[key] = {
      ...operation,
      ...(parsed ? { operation: parsed } : {}),
      phase:
        value.version === 1 ? (operation.terminal ? "terminal" : "observing") : operation.phase,
    } as ProjectedOperation;
  }
  const steps: OpsProjection["steps"] = {};
  if (value.version === 3) {
    if (
      !value.steps ||
      typeof value.steps !== "object" ||
      Array.isArray(value.steps) ||
      Object.keys(value.steps).length > 64
    )
      throw new JobObservationPending("invalid_identity");
    for (const [address, raw] of Object.entries(value.steps)) {
      const step = raw as { operationKey: string; requestedDeadlineAt: number };
      if (
        !OPERATION_KEY.test(address) ||
        !step ||
        Object.keys(step).length !== 2 ||
        !operations[step.operationKey] ||
        operations[step.operationKey]?.attempt?.requestedDeadlineAt !== step.requestedDeadlineAt
      )
        throw new JobObservationPending("invalid_identity");
      try {
        if (parseControlRootOperationKey(step.operationKey).notAfter !== step.requestedDeadlineAt)
          throw Error("Original managed root deadline changed");
      } catch {
        const operation = operations[step.operationKey]!;
        try {
          assertConfigurationMaintenanceProjectedStep(
            result as Record<string, unknown>,
            step.operationKey,
            operation.operation,
            operation.attempt,
          );
        } catch {
          throw new JobObservationPending("invalid_identity");
        }
      }
      steps[address] = step;
    }
  }
  for (const mapping of Object.values(steps)) {
    const entry = operations[mapping.operationKey];
    if (!entry) throw new JobObservationPending("invalid_identity");
    if (
      entry.terminal &&
      entry.phase !== "refused" &&
      entry.phase !== "unissued" &&
      opsKindRequiresControlAuthority(entry.kind) &&
      !entry.receiptDelivery
    )
      throw new JobObservationPending("recovery_required");
  }
  return {
    version: value.version as 1 | 2 | 3,
    steps,
    eventTotal: value.eventTotal,
    byteTotal: value.byteTotal,
    truncated: value.truncated,
    operations,
  };
}
