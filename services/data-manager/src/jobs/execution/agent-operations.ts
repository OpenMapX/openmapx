import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { DataExecutionInput } from "@openmapx/core/data-manager-contracts";
import {
  createControlRootOperationKey,
  normalizeExecutionAdmission,
  type OpsClient,
  OpsClientError,
  type OpsJobStatus,
  type OpsOperation,
  type OpsResultFor,
  opsOperationFingerprint,
  opsOperationSchema,
  parseControlRootOperationKey,
  parseOpsResult,
} from "@openmapx/core/ops";
import z from "zod/v4";
import type { DataExecutionContext } from "./runtime.js";

/** Host effects data-manager's in-process work asks the agent for. Each one
 * runs as an agent root under its own lease and key, which the data execution
 * reserves when it is admitted. */
export const RESERVED_AGENT_OPERATION_KINDS = [
  "valhalla.traffic.maintain",
  "valhalla.traffic.refreshWaysToEdges",
  "transitousLock.propose",
] as const;
type ReservedKind = (typeof RESERVED_AGENT_OPERATION_KINDS)[number];
export function isReservedAgentOperation(kind: string): kind is ReservedKind {
  return (RESERVED_AGENT_OPERATION_KINDS as readonly string[]).includes(kind);
}
/** Allowance after an operation's deadline for the agent to contain it, and
 * after an attempt for a request the agent never admitted (valid for 20
 * seconds) to lapse. */
const SETTLEMENT_MS = 30_000;
/** Agent answers that refuse a request before it records anything. */
const PRE_EFFECT_REFUSALS = new Set(["authorization", "validation", "busy", "conflict"]);
const key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  epoch = z.number().int().nonnegative().safe(),
  reserved = { kind: z.enum(RESERVED_AGENT_OPERATION_KINDS), operationKey: key },
  attempted = {
    ...reserved,
    operation: opsOperationSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    admittedAt: epoch,
    deadlineAt: epoch,
    cancellationRequestedAt: z.iso.datetime({ offset: true }).nullable(),
  };
export const dataAgentOperationSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ ...reserved, state: z.literal("reserved") }),
    z.strictObject({ ...attempted, state: z.literal("attempted") }),
    z.strictObject({
      ...attempted,
      state: z.literal("terminal"),
      agentState: z.enum(["succeeded", "failed", "timed_out", "not_admitted"]),
    }),
  ])
  .refine((entry) => entry.state === "reserved" || entry.operation.kind === entry.kind);
export type DataAgentOperation = z.infer<typeof dataAgentOperationSchema>;
type Attempted = Extract<DataAgentOperation, { state: "attempted" }>;

/** Every agent operation the work of `input` may ask for, keyed to expire with
 * the execution. A reservation the work never uses is released unused. */
export function reserveAgentOperations(
  input: DataExecutionInput,
  deadlineAt: number,
): DataAgentOperation[] {
  const kinds: ReservedKind[] =
    input.kind === "traffic-maintenance"
      ? ["valhalla.traffic.maintain", "valhalla.traffic.refreshWaysToEdges"]
      : input.kind === "traffic-predicted"
        ? ["valhalla.traffic.maintain"]
        : input.kind === "transit-proposal"
          ? ["transitousLock.propose"]
          : [];
  return kinds.map((kind) => ({
    state: "reserved",
    kind,
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
  }));
}
function requestedDeadline(entry: DataAgentOperation): number {
  return parseControlRootOperationKey(entry.operationKey).notAfter;
}
type Observation =
  | {
      state: "terminal";
      agentState: Extract<DataAgentOperation, { state: "terminal" }>["agentState"];
      status?: OpsJobStatus;
    }
  | { state: "pending"; status?: OpsJobStatus };
/** Reads the agent's record of an attempted operation by its key. It never
 * submits work. Anything short of a clear terminal answer is pending. */
async function observe(
  client: OpsClient,
  entry: Attempted,
  signal: AbortSignal,
): Promise<Observation> {
  let status: OpsJobStatus;
  try {
    status = await client.lookup(entry.operation, entry.operationKey, {
      fingerprint: entry.fingerprint,
      execution: { requestedDeadlineAt: requestedDeadline(entry) },
      signal,
    });
  } catch (error) {
    if (
      error instanceof OpsClientError &&
      error.errorClass === "not_found" &&
      Date.now() > entry.admittedAt + SETTLEMENT_MS
    )
      return { state: "terminal", agentState: "not_admitted" };
    return { state: "pending" };
  }
  if (
    status.operationKey !== entry.operationKey ||
    status.kind !== entry.kind ||
    status.fingerprint !== entry.fingerprint ||
    status.deadlineAt !== entry.deadlineAt
  )
    return { state: "pending" };
  if (status.state !== "succeeded" && status.state !== "failed" && status.state !== "timed_out")
    return { state: "pending", status };
  // An agent restart ends every unfinished job this way without proving its
  // effect stopped, so it counts only once the operation's time is over.
  if (status.errorClass === "recovery_required" && Date.now() <= entry.deadlineAt + SETTLEMENT_MS)
    return { state: "pending", status };
  return { state: "terminal", agentState: status.state, status };
}
async function cancel(
  client: OpsClient,
  entry: Attempted,
  status: OpsJobStatus | undefined,
): Promise<void> {
  if (!status) return;
  try {
    await client.cancel(status.operationId, {
      fingerprint: entry.fingerprint,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* A lost cancel answer is read back by the next lookup. */
  }
}
async function settle(
  context: DataExecutionContext,
  entry: Attempted,
  observed: Extract<Observation, { state: "terminal" }>,
) {
  await context.checkpointAgentOperation({
    ...entry,
    state: "terminal",
    agentState: observed.agentState,
  });
}
async function requestCancellation(context: DataExecutionContext, entry: Attempted) {
  if (entry.cancellationRequestedAt) return entry;
  const next = { ...entry, cancellationRequestedAt: new Date().toISOString() };
  await context.checkpointAgentOperation(next);
  return next;
}

/** Runs one reserved agent operation for the current data execution: records
 * it as attempted, sends it once and follows it by key to its terminal state. */
export async function runReservedAgentOperation(
  client: OpsClient,
  context: DataExecutionContext,
  operation: Extract<OpsOperation, { kind: ReservedKind }>,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<OpsResultFor<ReservedKind>> {
  const slot = (await context.record()).agentOperations.find(
    (entry) => entry.kind === operation.kind && entry.state === "reserved",
  );
  if (!slot) throw Error(`This data execution has no ${operation.kind} reservation left`);
  context.assertForward();
  const requestedDeadlineAt = requestedDeadline(slot),
    admission = normalizeExecutionAdmission({
      kind: operation.kind,
      operationKey: slot.operationKey,
      operationFingerprint: opsOperationFingerprint(operation),
      admittedAt: Date.now(),
      requestedDeadlineAt,
    });
  let entry: Attempted = {
    ...slot,
    state: "attempted",
    operation,
    fingerprint: admission.fingerprint,
    admittedAt: admission.admittedAt,
    deadlineAt: admission.deadlineAt,
    cancellationRequestedAt: null,
  };
  await context.checkpointAgentOperation(entry);
  const signal = options.signal
    ? AbortSignal.any([options.signal, context.signal])
    : context.signal;
  try {
    const accepted = await client.execute(operation, {
      operationKey: entry.operationKey,
      execution: { requestedDeadlineAt },
      signal,
    });
    if (accepted.execution === "sync") {
      await settle(context, entry, { state: "terminal", agentState: "succeeded" });
      return parseOpsResult(operation.kind, accepted.value);
    }
  } catch (error) {
    if (error instanceof OpsClientError && PRE_EFFECT_REFUSALS.has(error.errorClass)) {
      await settle(context, entry, { state: "terminal", agentState: "not_admitted" });
      throw error;
    }
    /* One request only; its outcome is read back by key. */
  }
  for (;;) {
    const observed = await observe(client, entry, AbortSignal.timeout(15_000));
    if (observed.state === "terminal") {
      await settle(context, entry, observed);
      if (observed.agentState === "succeeded" && observed.status)
        return parseOpsResult(operation.kind, observed.status.result);
      throw Error(
        `Operation ${operation.kind} did not succeed (${observed.status?.errorClass ?? observed.agentState})`,
      );
    }
    if (signal.aborted) {
      entry = await requestCancellation(context, entry);
      await cancel(client, entry, observed.status);
    }
    await delay(options.pollIntervalMs ?? 1000);
  }
}

/** Follows every attempted agent operation of the execution by key, asking the
 * agent to cancel those still running when `cancelRunning` is set. Settled
 * means none is left attempted. */
export async function settleAgentOperations(
  context: DataExecutionContext,
  cancelRunning: boolean,
  client: () => OpsClient,
): Promise<"settled" | "pending"> {
  let pending = false;
  for (const value of (await context.record()).agentOperations) {
    if (value.state !== "attempted") continue;
    let entry = value;
    try {
      const observed = await observe(client(), entry, AbortSignal.timeout(15_000));
      if (observed.state === "terminal") {
        await settle(context, entry, observed);
        continue;
      }
      pending = true;
      if (cancelRunning) {
        entry = await requestCancellation(context, entry);
        await cancel(client(), entry, observed.status);
      }
    } catch {
      pending = true;
    }
  }
  return pending ? "pending" : "settled";
}
