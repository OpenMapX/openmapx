import type { OpsOperation, OpsOperationKind, OpsResultFor } from "@openmapx/core/ops";
import type { JobContext } from "./job-runner";
import {
  type ApiOpsClient,
  createApiOpsClient,
  createDurableOpsKey,
  type FollowOpsEventsState,
  followOpsEvents,
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
  operationId: string;
  cursor: number;
  events: number;
  bytes: number;
  truncated: boolean;
  terminal: boolean;
}

interface OpsProjection {
  version: 1;
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
  return { version: 1, eventTotal: 0, byteTotal: 0, truncated: false, operations: {} };
}

function readProjection(result: unknown): OpsProjection {
  if (!result || typeof result !== "object" || Array.isArray(result)) return emptyProjection();
  const candidate = (result as Record<string, unknown>).opsProjection;
  if (candidate === undefined) return emptyProjection();
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Invalid durable operations projection");
  }
  const value = candidate as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !boundedInteger(value.eventTotal, ADMIN_EVENT_LIMIT) ||
    !boundedInteger(value.byteTotal, ADMIN_EVENT_BYTE_LIMIT) ||
    typeof value.truncated !== "boolean" ||
    !value.operations ||
    typeof value.operations !== "object" ||
    Array.isArray(value.operations)
  ) {
    throw new Error("Invalid durable operations projection");
  }
  const entries = Object.entries(value.operations as Record<string, unknown>);
  if (entries.length > MAX_PROJECTED_OPERATIONS)
    throw new Error("Invalid durable operations projection");
  const operations: Record<string, ProjectedOperation> = {};
  for (const [key, raw] of entries) {
    if (!OPERATION_KEY.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid durable operations projection");
    }
    const operation = raw as Record<string, unknown>;
    if (
      operation.operationKey !== key ||
      typeof operation.operationId !== "string" ||
      !OPERATION_ID.test(operation.operationId) ||
      typeof operation.kind !== "string" ||
      !boundedInteger(operation.cursor, Number.MAX_SAFE_INTEGER) ||
      !boundedInteger(operation.events, ADMIN_EVENT_LIMIT) ||
      !boundedInteger(operation.bytes, ADMIN_EVENT_BYTE_LIMIT) ||
      typeof operation.truncated !== "boolean" ||
      typeof operation.terminal !== "boolean"
    ) {
      throw new Error("Invalid durable operations projection");
    }
    operations[key] = operation as unknown as ProjectedOperation;
  }
  return {
    version: 1,
    eventTotal: value.eventTotal,
    byteTotal: value.byteTotal,
    truncated: value.truncated,
    operations,
  };
}

async function persistProjection(context: JobContext, projection: OpsProjection): Promise<void> {
  const value = { ...(context.checkpointResult ?? {}), opsProjection: projection };
  await context.checkpoint(value);
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
    throw new Error("Invalid durable operations projection");

  const admission = await submitOpsOperationWithRecovery(client, operation, operationKey, {
    signal: context.signal,
    admissionAlreadyAttempted: restored !== undefined,
  });
  if (admission.execution === "sync") return admission.value;
  if (restored && restored.operationId !== admission.operationId) {
    throw new Error("Invalid durable operations projection");
  }
  if (!restored && Object.keys(projection.operations).length >= MAX_PROJECTED_OPERATIONS) {
    throw new Error("Durable operations projection limit exceeded");
  }

  let projected: ProjectedOperation =
    restored ??
    ({
      kind: operation.kind,
      operationKey,
      operationId: admission.operationId,
      cursor: 0,
      events: projection.eventTotal,
      bytes: projection.byteTotal,
      truncated: false,
      terminal: false,
    } satisfies ProjectedOperation);
  projection.operations[operationKey] = projected;
  await persistProjection(context, projection);

  const eventMirror = followOpsEvents(client, admission.operationId, {
    signal: context.signal,
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
      } catch {
        // Logging is a projection into the API database. Losing that
        // projection must not change the durable agent operation.
      }
    },
    onProgress: async (state) => {
      projected = { ...projected, ...state };
      projection.eventTotal = state.events;
      projection.byteTotal = state.bytes;
      projection.truncated = state.truncated;
      projection.operations[operationKey] = projected;
      await persistProjection(context, projection);
    },
  }).catch(() => undefined);

  // The mirror's returned state is authoritative for its final cursor and
  // counters: its limit and byte-budget exits are reported here rather than
  // through an intermediate progress callback.
  const adoptMirrorState = (state: FollowOpsEventsState | undefined): void => {
    if (!state) return;
    projected = { ...projected, ...state };
    projection.eventTotal = state.events;
    projection.byteTotal = state.bytes;
    projection.truncated = state.truncated;
  };

  try {
    const result = await waitForOpsResult(client, operation.kind, admission, {
      signal: context.signal,
      pollIntervalMs: options.pollIntervalMs,
    });
    adoptMirrorState(await eventMirror);
    projected = { ...projected, terminal: true };
    projection.operations[operationKey] = projected;
    await persistProjection(context, projection);
    return result;
  } catch (error) {
    adoptMirrorState(await eventMirror);
    projection.operations[operationKey] = projected;
    await persistProjection(context, projection);
    throw error;
  }
}

export interface CancelAdminJobOperationsOptions {
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
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
  client: Pick<ApiOpsClient, "cancel" | "status"> = createApiOpsClient(),
  options: CancelAdminJobOperationsOptions = {},
): Promise<AdminJobCancellationOutcome> {
  const projection = readProjection(result);
  const pending = Object.values(projection.operations).filter((operation) => !operation.terminal);
  if (pending.length === 0) return "completed";
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
  for (const operation of pending) {
    // The agent enters `termination_pending` only from a cancellation request,
    // so observing it here is equivalent evidence to the durable marker.
    let sawTerminationPending = false;
    let status: Awaited<ReturnType<ApiOpsClient["cancel"]>> | undefined;
    try {
      status = await client.cancel(operation.operationId, { signal: AbortSignal.timeout(2_000) });
    } catch {
      // The cancel request may have reached the agent. Reconcile through its
      // authenticated journal status rather than treating response loss as success.
    }
    for (let attempt = 0; attempt < CANCEL_POLL_ATTEMPTS; attempt += 1) {
      if (!status || !["succeeded", "failed", "timed_out"].includes(status.state)) {
        try {
          status = await client.status(operation.kind, operation.operationId, {
            signal: AbortSignal.timeout(2_000),
          });
        } catch {
          status = undefined;
        }
      }
      if (status) {
        if (
          status.operationId !== operation.operationId ||
          status.operationKey !== operation.operationKey ||
          status.kind !== operation.kind
        ) {
          throw new Error("Invalid operations cancellation status");
        }
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
  if (outcomes.includes("contained")) return "canceled";
  return outcomes.every((outcome) => outcome === "succeeded") ? "completed" : "already_terminal";
}
