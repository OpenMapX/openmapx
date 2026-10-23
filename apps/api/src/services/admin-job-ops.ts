import {
  configurationApplyResultSchema,
  OPS_KIND_POLICIES,
  type OpsFailureResult,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  type OpsSubmitResult,
  opsFailureResultSchema,
  opsOperationFingerprint,
  opsOperationSchema,
  type ProcessDiagnostics,
  processDiagnosticsSchema,
} from "@openmapx/core/ops";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import {
  type ApiJobChildAttempt,
  apiJobChildAttemptSchema,
  issueApiJobChildAssertion,
  prepareApiJobChildAttempt,
} from "./admin-job-parent";
import { JobOwnershipLost } from "./admin-job-state";
import type { JobContext } from "./job-runner";
import {
  type ApiOpsClient,
  ApiOpsError,
  createApiOpsClient,
  createDurableOpsKey,
  followOpsEvents,
  OpsObservationPending,
  submitOpsOperationWithRecovery,
  waitForOpsResult,
} from "./ops-client";

const ADMIN_EVENT_LIMIT = 2_000;
const ADMIN_EVENT_BYTE_LIMIT = 1024 * 1024;
const MAX_PROJECTED_OPERATIONS = 64;
const CANCEL_POLL_ATTEMPTS = 8;
const OPERATION_KEY = /^opk1_[A-Za-z0-9_-]{16,64}$/;
const OPERATION_ID = /^job1_[A-Za-z0-9_-]{16,64}$/;

interface ProjectedOperation {
  kind: OpsOperationKind;
  operationKey: string;
  operationId?: string;
  operation?: OpsOperation;
  phase: "admitting" | "observing" | "terminal";
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
}

interface OpsProjection {
  version: 2;
  eventTotal: number;
  byteTotal: number;
  truncated: boolean;
  operations: Record<string, ProjectedOperation>;
}

export interface ExecuteAdminJobOperationOptions {
  client?: ApiOpsClient;
  operationKey?: string;
  pollIntervalMs?: number;
  durableIdentity?: string;
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function emptyProjection(): OpsProjection {
  return { version: 2, eventTotal: 0, byteTotal: 0, truncated: false, operations: {} };
}

function readProjection(result: unknown): OpsProjection {
  if (!result || typeof result !== "object" || Array.isArray(result)) return emptyProjection();
  const candidate = (result as Record<string, unknown>).opsProjection;
  if (candidate === undefined) return emptyProjection();
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new JobObservationPending("invalid_identity");
  }
  const value = candidate as Record<string, unknown>;
  if (
    (value.version !== 1 && value.version !== 2) ||
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
      value.version === 2 &&
      !["admitting", "observing", "terminal"].includes(operation.phase as string)
    )
      throw new JobObservationPending("invalid_identity");
    const checked =
      operation.operation === undefined
        ? undefined
        : opsOperationSchema.safeParse(operation.operation);
    if (checked && !checked.success) throw new JobObservationPending("invalid_identity");
    const parsed = checked?.data;
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
        !parsed ||
        attempt.data.childOperationKey !== key ||
        attempt.data.childOperationFingerprint !== opsOperationFingerprint(parsed)
      )
        throw new JobObservationPending("invalid_identity");
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
  return {
    version: 2,
    eventTotal: value.eventTotal,
    byteTotal: value.byteTotal,
    truncated: value.truncated,
    operations,
  };
}

async function persistProjection(
  context: JobContext,
  projection: OpsProjection,
  admissionKey?: string,
): Promise<void> {
  const value = { ...(context.checkpointResult ?? {}), opsProjection: projection };
  if (admissionKey) await context.checkpoint(value, undefined, admissionKey);
  else await context.checkpoint(value);
  context.checkpointResult = value;
}

/**
 * Submit a typed administrative effect and mirror its bounded durable event
 * stream into the existing API job log. The agent journal remains the source
 * of truth: an API-side log failure or disconnect never cancels the effect.
 */
export async function executeAdminJobOperation<K extends OpsOperationKind>(
  context: JobContext,
  operation: Extract<OpsOperation, { kind: K }>,
  keyNamespace: string,
  options: ExecuteAdminJobOperationOptions = {},
): Promise<OpsResultFor<K>> {
  const client = options.client ?? createApiOpsClient();
  const durableIdentity = options.durableIdentity
    ? `${context.jobId}:${options.durableIdentity}`
    : context.jobId;
  const operationKey = options.operationKey ?? createDurableOpsKey(keyNamespace, durableIdentity);
  const projection = readProjection(context.checkpointResult);
  const restored = projection.operations[operationKey];
  if (restored && restored.kind !== operation.kind)
    throw new JobObservationPending("invalid_identity");

  if (!restored && Object.keys(projection.operations).length >= MAX_PROJECTED_OPERATIONS)
    throw new Error("Durable operations projection limit exceeded");
  // A retained typed body wins over any newer desired state. Legacy v1 entries
  // have only an ID and are observed directly; no body/identity is invented.
  const exactOperation =
    restored?.operation ?? (restored ? undefined : opsOperationSchema.parse(operation));
  const projected: ProjectedOperation = restored ?? {
    kind: operation.kind,
    operationKey,
    operation: exactOperation,
    phase: "admitting",
    cursor: 0,
    events: projection.eventTotal,
    bytes: projection.byteTotal,
    truncated: false,
    terminal: false,
    attempt: prepareApiJobChildAttempt(context, operation, operationKey),
  };
  projection.operations[operationKey] = projected;
  if (!restored) await persistProjection(context, projection, operationKey); // CAS BEFORE first POST or signing
  return observeOperation(context, projection, projected, client, options, !restored) as Promise<
    OpsResultFor<K>
  >;
}

export function retainedAdminJobOperation(ctx: JobContext, key: string): OpsOperation | undefined {
  return readProjection(ctx.checkpointResult).operations[key]?.operation;
}
export function hasRetainedAdminJobOperation(ctx: JobContext, key: string): boolean {
  return readProjection(ctx.checkpointResult).operations[key] !== undefined;
}
export async function observeRetainedAdminJobOperation(
  ctx: JobContext,
  key: string,
): Promise<unknown> {
  const projection = readProjection(ctx.checkpointResult);
  const retained = projection.operations[key];
  if (!retained) throw new JobObservationPending("recovery_required");
  return observeOperation(ctx, projection, retained, createApiOpsClient(), {});
}

async function observeOperation(
  context: JobContext,
  projection: OpsProjection,
  projected: ProjectedOperation,
  client: ApiOpsClient,
  options: ExecuteAdminJobOperationOptions,
  fresh = false,
): Promise<unknown> {
  context.signal.throwIfAborted();
  const observer = new AbortController();
  const signal = AbortSignal.any([context.signal, observer.signal]);
  let ownershipLost: JobOwnershipLost | undefined;
  const retireIfLost = (error: unknown) => {
    if (error instanceof JobOwnershipLost) {
      ownershipLost = error;
      observer.abort(error);
      throw error;
    }
  };
  const identity = {
    kind: projected.kind,
    operationKey: projected.operationKey,
    operationId: projected.operationId,
  };
  if (projected.attempt && projected.attempt.apiJobId !== context.jobId)
    throw new OpsObservationPending(identity, "invalid_identity");
  if (projected.terminal && (projected.result !== undefined || projected.errorClass)) {
    if (projected.errorClass)
      throw new ApiOpsError(
        projected.errorClass as ApiOpsError["errorClass"],
        projected.failureResult,
      );
    return projected.result;
  }
  const safeCheckpoint = async () => {
    try {
      await persistProjection(context, projection);
    } catch (error) {
      retireIfLost(error);
      /* Ordinary projection failure never cancels effects. */
    }
  };
  try {
    let admission: OpsSubmitResult<OpsOperationKind>;
    if (projected.operationId) {
      // A retained ID is not authority to adopt another operation's logs.
      // Authenticate and match its complete identity before opening the stream.
      const status = await client
        .status(projected.kind, projected.operationId, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        })
        .catch(() => {
          throw new OpsObservationPending(
            identity,
            context.signal.aborted ? "observer_deadline" : "unavailable",
          );
        });
      if (
        status.kind !== projected.kind ||
        status.operationId !== projected.operationId ||
        status.operationKey !== projected.operationKey ||
        (projected.fingerprint !== undefined && status.fingerprint !== projected.fingerprint) ||
        (projected.deadlineAt !== undefined && status.deadlineAt !== projected.deadlineAt)
      )
        throw new OpsObservationPending(identity, "invalid_identity");
      admission = {
        execution: "async" as const,
        kind: projected.kind,
        operationId: projected.operationId,
        operationKey: projected.operationKey,
        state: "queued" as const,
        fingerprint: projected.fingerprint,
        deadlineAt: projected.deadlineAt,
      };
    } else {
      if (!projected.operation) throw new OpsObservationPending(identity, "invalid_identity");
      admission = await submitOpsOperationWithRecovery(
        client,
        projected.operation,
        projected.operationKey,
        {
          signal,
          admissionAlreadyAttempted: !fresh,
          recoveryTimeoutMs: 2_000,
          ...(projected.attempt
            ? { execution: { requestedDeadlineAt: projected.attempt.requestedDeadlineAt } }
            : {}),
          ...(fresh && projected.attempt
            ? { parentAssertion: await issueApiJobChildAssertion(projected.attempt) }
            : {}),
        },
      );
      if (admission.execution === "sync") {
        projected.result = admission.value;
        projected.terminal = true;
        projected.phase = "terminal";
        await persistProjection(context, projection);
        return admission.value;
      }
      projected.operationId = admission.operationId;
      projected.fingerprint = admission.fingerprint;
      projected.deadlineAt = admission.deadlineAt;
      projected.phase = "observing";
      // If this checkpoint fails, the admitting intent still supports lookup-only recovery.
      try {
        await persistProjection(context, projection);
      } catch (error) {
        retireIfLost(error);
        throw new OpsObservationPending(identity, "transport");
      }
    }
    const mirrorController = new AbortController();
    const mirrorSignal = AbortSignal.any([signal, mirrorController.signal]);
    const mirror = projected.mirrorStopped
      ? Promise.resolve()
      : followOpsEvents(client, admission.operationId, {
          signal: mirrorSignal,
          maxEvents: ADMIN_EVENT_LIMIT,
          maxBytes: ADMIN_EVENT_BYTE_LIMIT,
          pollIntervalMs: options.pollIntervalMs,
          cancelOnExit: false,
          initial: {
            cursor: projected.cursor,
            events: projection.eventTotal,
            bytes: projection.byteTotal,
            truncated: projection.truncated,
          },
          onLog: async (stream, message, cursor) => {
            try {
              await context.log(message, stream, `ops:${admission.operationId}:${cursor}`, cursor);
            } catch (error) {
              retireIfLost(error);
              projected.truncated = true;
              projection.truncated = true;
            }
          },
          onProgress: async (state) => {
            Object.assign(projected, state);
            projection.eventTotal = state.events;
            projection.byteTotal = state.bytes;
            projection.truncated ||= state.truncated;
            await safeCheckpoint();
          },
        })
          .then(async (state) => {
            if (state) {
              Object.assign(projected, state);
              projected.mirrorStopped = true;
              projection.truncated ||= state.truncated;
              await safeCheckpoint();
            }
          })
          .catch((error) => {
            // Observe this rejection immediately; propagate after joining the
            // result observer so it cannot become an unhandled rejection.
            if (error instanceof JobOwnershipLost) {
              ownershipLost = error;
              observer.abort(error);
            }
          });
    const observed = await waitForOpsResult(client, projected.kind, admission, {
      signal,
      pollIntervalMs: options.pollIntervalMs,
      ...(context.observationOnly ? { timeoutMs: 2_000 } : {}),
      onStatus: (status) => {
        if (status.diagnostics) projected.diagnostics = status.diagnostics;
        if (status.failureResult) projected.failureResult = status.failureResult;
      },
    }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    mirrorController.abort();
    await mirror;
    if (ownershipLost) throw ownershipLost;
    if (!observed.ok) throw observed.error;
    const result = observed.result;
    projected.result = result;
    const configuration = configurationApplyResultSchema.safeParse(result);
    if (configuration.success)
      context.checkpointResult = {
        ...context.checkpointResult,
        configuration: configuration.data,
      };
    projected.terminal = true;
    projected.phase = "terminal";
    delete projected.outcome;
    return result;
  } catch (error) {
    if (error instanceof ApiOpsError) {
      projected.failureResult = error.failureResult;
      projected.errorClass = error.errorClass;
      projected.terminal = true;
      projected.phase = "terminal";
      context.checkpointResult = {
        ...context.checkpointResult,
        ...error.failureResult,
        ...(error.errorClass === "host_update_required" ? { errorCode: error.errorClass } : {}),
      };
    } else {
      projected.outcome = "unknown";
    }
    throw error;
  } finally {
    context.checkpointResult = {
      ...context.checkpointResult,
      ...projected.failureResult,
      ...(projection.truncated ? { logTruncated: true } : {}),
    };
    if (projected.diagnostics)
      context.checkpointResult = {
        ...context.checkpointResult,
        diagnostics: projected.diagnostics,
      };
    if (!ownershipLost) await safeCheckpoint();
  }
}

/** Reconciliation observes retained attempts only. It never invokes the original handler. */
export async function resumeAdminJobObservation(
  ctx: JobContext,
): Promise<Record<string, unknown> | undefined> {
  const projection = readProjection(ctx.checkpointResult);
  const entries = Object.values(projection.operations);
  const firstEntry = entries[0];
  if (!firstEntry) throw new JobObservationPending("recovery_required");
  let client: ApiOpsClient;
  try {
    client = createApiOpsClient();
  } catch {
    throw new JobObservationPending("transport");
  }
  let failure: ApiOpsError | undefined;
  for (const operation of entries) {
    try {
      await observeOperation(ctx, projection, operation, client, {});
    } catch (error) {
      if (!(error instanceof ApiOpsError)) throw error;
      failure ??= error;
    }
  }
  const evidence = { ...ctx.checkpointResult };
  if (hasUnsettledHardlinks(evidence)) throw new JobObservationPending("recovery_required");
  if (failure)
    throw new AdminJobFailure(failure.message, { ...evidence, ...failure.failureResult });
  const settled = evidence._settled as
    | { status: string; result?: Record<string, unknown>; error?: string }
    | undefined;
  if (settled?.status === "failed")
    throw new AdminJobFailure(settled.error ?? "Operation failed", {
      ...evidence,
      ...settled.result,
    });
  if (settled?.status === "success") return { ...evidence, ...settled.result };
  const completion = evidence._completion as
    | { operationKey?: string; result?: Record<string, unknown> }
    | undefined;
  if (
    completion?.operationKey &&
    entries.some((entry) => entry.operationKey === completion.operationKey && entry.terminal)
  )
    return { ...evidence, ...completion.result };
  // Single-effect jobs have a complete retained receipt. Multi-step workflows
  // require the original completion checkpoint; observing a render is not apply.
  if (
    [
      "service.stop",
      "service.restart",
      "backup.operation",
      "data.operation",
      "system.diagnostics",
    ].includes(ctx.jobType ?? "") &&
    entries.length === 1
  )
    return { ...evidence, ...((entries[0]?.result as Record<string, unknown>) ?? {}) };
  throw new OpsObservationPending(
    {
      kind: firstEntry.kind,
      operationKey: firstEntry.operationKey,
      operationId: firstEntry.operationId,
    },
    "recovery_required",
  );
}

function hasUnsettledHardlinks(result: unknown): boolean {
  const attempts = (result as { _hardlinkAttempts?: Record<string, { phase?: string }> } | null)
    ?._hardlinkAttempts;
  return !!attempts && Object.values(attempts).some((attempt) => attempt?.phase !== "complete");
}

export interface CancelAdminJobOperationsOptions {
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  jobId?: string;
  onEvidence?: (evidence: Record<string, unknown>) => Promise<void>;
}

/** Per-operation reconciliation outcome. */
type AdminOperationCancellation = "succeeded" | "contained" | "already_terminal";

/**
 * Aggregate cancellation outcome.
 *
 * - `canceled` — at least one operation was contained by this request.
 * - `completed` — every operation had already succeeded.
 * - `already_terminal` — every operation is terminal, none was contained by
 *   this request, and at least one had already failed or timed out.
 * - `pending` — at least one operation is still not terminal.
 */
export type AdminJobCancellationOutcome = "canceled" | "completed" | "already_terminal" | "pending";

export async function cancelAdminJobOperations(
  result: unknown,
  client: Pick<ApiOpsClient, "cancel" | "status" | "lookup"> = createApiOpsClient(),
  options: CancelAdminJobOperationsOptions = {},
): Promise<AdminJobCancellationOutcome> {
  const projection = readProjection(result);
  const pending = Object.values(projection.operations);
  if (pending.length === 0) return "pending";
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10_000) {
    throw new Error("Invalid cancellation poll interval");
  }

  // Each operation is reconciled on its own. A sibling that finished
  // successfully must not mask another that this request actually contained,
  // and a failure that predates this request must not be reported as a
  // cancellation it did not cause.
  const outcomes: AdminOperationCancellation[] = [];
  const readSignal = () =>
    options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(2_000)])
      : AbortSignal.timeout(2_000);
  for (const operation of pending) {
    if (options.signal?.aborted) return "pending";
    if (options.jobId && operation.attempt && operation.attempt.apiJobId !== options.jobId)
      return "pending";
    if (!operation.operationId) {
      if (!operation.operation) return "pending";
      try {
        const found = await client.lookup(operation.operation, operation.operationKey, {
          signal: readSignal(),
          ...(operation.attempt
            ? { execution: { requestedDeadlineAt: operation.attempt.requestedDeadlineAt } }
            : {}),
        });
        if (found.kind !== operation.kind || found.operationKey !== operation.operationKey)
          return "pending";
        operation.operationId = found.operationId;
        operation.fingerprint = found.fingerprint;
        operation.deadlineAt = found.deadlineAt;
      } catch {
        return "pending";
      }
    }
    // The agent enters `termination_pending` only from a cancellation request,
    // so observing it here is equivalent evidence to the durable marker.
    let sawTerminationPending = false;
    let status: Awaited<ReturnType<ApiOpsClient["cancel"]>> | undefined;
    const matches = (value: Awaited<ReturnType<ApiOpsClient["cancel"]>>) =>
      value &&
      value.operationId === operation.operationId &&
      value.operationKey === operation.operationKey &&
      value.kind === operation.kind &&
      (operation.fingerprint === undefined || value.fingerprint === operation.fingerprint) &&
      (operation.deadlineAt === undefined || value.deadlineAt === operation.deadlineAt);
    try {
      status = await client.status(operation.kind, operation.operationId, { signal: readSignal() });
      if (!matches(status)) return "pending";
      sawTerminationPending = status.state === "termination_pending";
      if (!["succeeded", "failed", "timed_out"].includes(status.state))
        status = await client.cancel(operation.operationId, {
          signal: readSignal(),
          ...(operation.fingerprint ? { fingerprint: operation.fingerprint } : {}),
        });
    } catch {
      // The cancel request may have reached the agent. Reconcile through its
      // authenticated journal status rather than treating response loss as success.
    }
    for (let attempt = 0; attempt < CANCEL_POLL_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted) return "pending";
      if (!status || !["succeeded", "failed", "timed_out"].includes(status.state)) {
        try {
          status = await client.status(operation.kind, operation.operationId, {
            signal: readSignal(),
          });
        } catch {
          status = undefined;
        }
      }
      if (status) {
        if (
          status.operationId !== operation.operationId ||
          status.operationKey !== operation.operationKey ||
          (operation.fingerprint !== undefined && status.fingerprint !== operation.fingerprint) ||
          (operation.deadlineAt !== undefined && status.deadlineAt !== operation.deadlineAt) ||
          status.kind !== operation.kind
        ) {
          throw new Error("Invalid operations cancellation status");
        }
        await options.onEvidence?.({
          ...status.failureResult,
          ...(status.diagnostics ? { diagnostics: status.diagnostics } : {}),
        });
        if (status.errorClass === "recovery_required") return "pending";
        if (status.state === "termination_pending") sawTerminationPending = true;
        if (status.state === "succeeded") break;
        if (status.state === "failed" || status.state === "timed_out") break;
      }
      if (attempt + 1 < CANCEL_POLL_ATTEMPTS) await sleep(pollIntervalMs);
    }
    if (!status || !["succeeded", "failed", "timed_out"].includes(status.state)) return "pending";
    outcomes.push(
      status.state === "succeeded"
        ? "succeeded"
        : status.terminationRequestedAt !== undefined || sawTerminationPending
          ? "contained"
          : "already_terminal",
    );
  }
  if (hasUnsettledHardlinks(result)) return "pending";
  if (outcomes.includes("contained")) return "canceled";
  return outcomes.every((outcome) => outcome === "succeeded") ? "completed" : "already_terminal";
}
