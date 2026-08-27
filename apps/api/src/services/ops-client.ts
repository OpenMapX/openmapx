import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  OPS_KIND_POLICIES,
  OPS_MAX_EVENT_BATCH,
  OPS_MAX_EVENT_MESSAGE_BYTES,
  OpsClient,
  OpsClientError,
  type OpsErrorClass,
  type OpsEventBatch,
  type OpsJobStatusFor,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  type OpsSubmitResult,
} from "@openmapx/core/ops";

const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_WAIT_TIMEOUT_MS = 30 * 60_000 + 5_000;
const MAX_STREAM_EVENTS = 2_000;
const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_TRANSIENT_STATUS_ATTEMPTS = 3;
const AMBIGUOUS_ADMISSION_RECOVERY_MS = 2_000;

export type ApiOpsClient = Pick<OpsClient, "execute" | "status" | "events" | "cancel" | "lookup">;

export class ApiOpsError extends Error {
  constructor(readonly errorClass: OpsErrorClass) {
    super("Operations request failed");
    this.name = "ApiOpsError";
  }
}

export function createApiOpsClient(env: NodeJS.ProcessEnv = process.env): OpsClient {
  const baseUrl = env.OPS_AGENT_URL?.trim();
  const tokenFile = env.OPS_AGENT_TOKEN_FILE?.trim();
  if (!baseUrl || !tokenFile || !isAbsolute(tokenFile)) {
    throw new Error("Ops agent configuration is unavailable");
  }
  try {
    return new OpsClient({ baseUrl, tokenFile });
  } catch {
    throw new Error("Ops agent configuration is unavailable");
  }
}

export function createDurableOpsKey(namespace: string, durableIdentity: string): string {
  if (
    !/^[a-z][a-z0-9.-]{0,63}$/.test(namespace) ||
    durableIdentity.length < 1 ||
    durableIdentity.length > 4_096
  ) {
    throw new Error("Invalid durable operations identity");
  }
  const digest = createHash("sha256")
    .update("openmapx-ops-key-v1\0")
    .update(namespace)
    .update("\0")
    .update(durableIdentity)
    .digest("base64url");
  return `opk1_${digest}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function translateError(error: unknown): never {
  if (error instanceof ApiOpsError) throw error;
  if (error instanceof OpsClientError) throw new ApiOpsError(error.errorClass);
  throw error;
}

function errorClass(error: unknown): OpsErrorClass | undefined {
  if (error instanceof ApiOpsError || error instanceof OpsClientError) return error.errorClass;
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError"
  );
}

function isTransientTransportError(error: unknown): boolean {
  return isAbortError(error) || ["runtime", "timeout", "busy"].includes(errorClass(error) ?? "");
}

function validatePositiveBounded(value: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${label}`);
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export interface WaitForOpsResultOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function waitForOpsResult<K extends OpsOperationKind>(
  client: ApiOpsClient,
  kind: K,
  admission: Extract<OpsSubmitResult<K>, { execution: "async" }>,
  options: WaitForOpsResultOptions = {},
): Promise<OpsResultFor<K>> {
  if (admission.kind !== kind) throw new ApiOpsError("runtime");
  const timeoutMs =
    options.timeoutMs ?? Math.min(OPS_KIND_POLICIES[kind].timeoutMs + 5_000, MAX_WAIT_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  validatePositiveBounded(timeoutMs, MAX_WAIT_TIMEOUT_MS, "operations wait timeout");
  validatePositiveBounded(pollIntervalMs, 10_000, "operations poll interval");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  let transientStatusAttempts = 0;

  while (true) {
    throwIfAborted(options.signal);
    if (now() >= deadline) throw new ApiOpsError("timeout");
    let status: OpsJobStatusFor<K>;
    try {
      status = await client.status(kind, admission.operationId, { signal: options.signal });
      transientStatusAttempts = 0;
    } catch (error) {
      if (isTransientTransportError(error) && !options.signal?.aborted) {
        transientStatusAttempts += 1;
        if (transientStatusAttempts < MAX_TRANSIENT_STATUS_ATTEMPTS && now() < deadline) {
          await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())), options.signal);
          continue;
        }
      }
      translateError(error);
    }
    if (status.operationKey !== admission.operationKey) throw new ApiOpsError("runtime");
    if (status.state === "succeeded") return status.result;
    if (status.state === "failed" || status.state === "timed_out") {
      throw new ApiOpsError(status.errorClass);
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new ApiOpsError("timeout");
    await sleep(Math.min(pollIntervalMs, remaining), options.signal);
  }
}

export interface FollowOpsEventsOptions {
  signal?: AbortSignal;
  maxEvents?: number;
  maxBytes?: number;
  pollIntervalMs?: number;
  onLog(stream: "stdout" | "stderr", message: string, cursor: number): void | Promise<void>;
  initial?: FollowOpsEventsState;
  onProgress?(state: FollowOpsEventsState): void | Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Interactive streams cancel when their reader disappears. Durable admin
   * jobs set this false because the agent journal, not the API connection, is
   * the operation authority across API restarts.
   */
  cancelOnExit?: boolean;
}

export interface FollowOpsEventsState {
  cursor: number;
  events: number;
  bytes: number;
  truncated: boolean;
}

export async function followOpsEvents(
  client: ApiOpsClient,
  operationId: string,
  options: FollowOpsEventsOptions,
): Promise<FollowOpsEventsState> {
  const maxEvents = options.maxEvents ?? MAX_STREAM_EVENTS;
  const maxBytes = options.maxBytes ?? MAX_STREAM_BYTES;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  validatePositiveBounded(maxEvents, MAX_STREAM_EVENTS, "operations event count");
  validatePositiveBounded(maxBytes, MAX_STREAM_BYTES, "operations event bytes");
  validatePositiveBounded(pollIntervalMs, 10_000, "operations poll interval");
  const sleep = options.sleep ?? defaultSleep;
  const initial = options.initial ?? { cursor: 0, events: 0, bytes: 0, truncated: false };
  if (
    !Number.isInteger(initial.cursor) ||
    initial.cursor < 0 ||
    !Number.isInteger(initial.events) ||
    initial.events < 0 ||
    initial.events > maxEvents ||
    !Number.isInteger(initial.bytes) ||
    initial.bytes < 0 ||
    initial.bytes > maxBytes ||
    typeof initial.truncated !== "boolean"
  ) {
    throw new Error("Invalid operations event checkpoint");
  }
  let cursor = initial.cursor;
  let eventCount = initial.events;
  let byteCount = initial.bytes;
  let truncated = initial.truncated;
  let terminal = false;

  // Every exit must leave a durable checkpoint. A limit or byte-budget exit
  // that skipped this would persist the pre-page cursor while its earlier
  // events had already been emitted, so a restart would replay and re-charge
  // them, and a normal completion would claim it was not truncated.
  const finish = async (state: FollowOpsEventsState): Promise<FollowOpsEventsState> => {
    await options.onProgress?.(state);
    return state;
  };

  try {
    while (true) {
      throwIfAborted(options.signal);
      const limit = Math.min(OPS_MAX_EVENT_BATCH, maxEvents - eventCount);
      if (limit < 1) {
        return await finish({ cursor, events: eventCount, bytes: byteCount, truncated: true });
      }
      let batch: OpsEventBatch;
      try {
        batch = await client.events(operationId, {
          after: cursor,
          limit,
          signal: options.signal,
        });
      } catch (error) {
        translateError(error);
      }
      truncated ||= batch.truncated;
      for (const event of batch.events) {
        eventCount += 1;
        if (event.type !== "log") continue;
        const bytes = new TextEncoder().encode(event.message).byteLength;
        if (bytes > OPS_MAX_EVENT_MESSAGE_BYTES || byteCount + bytes > maxBytes) {
          // The event is intentionally dropped. Advance past it so a restart
          // resumes after it rather than replaying this page, and charge it
          // once so the cursor and the counter stay consistent.
          return await finish({
            cursor: event.cursor,
            events: eventCount,
            bytes: byteCount,
            truncated: true,
          });
        }
        byteCount += bytes;
        await options.onLog(event.stream, event.message, event.cursor);
      }
      cursor = batch.nextCursor;
      await options.onProgress?.({ cursor, events: eventCount, bytes: byteCount, truncated });
      throwIfAborted(options.signal);
      if (batch.terminal) {
        terminal = true;
        return await finish({ cursor, events: eventCount, bytes: byteCount, truncated });
      }
      if (eventCount >= maxEvents) {
        return await finish({ cursor, events: eventCount, bytes: byteCount, truncated: true });
      }
      await sleep(pollIntervalMs, options.signal);
    }
  } finally {
    if (!terminal && options.cancelOnExit !== false) {
      try {
        await client.cancel(operationId, {
          signal: AbortSignal.timeout(AMBIGUOUS_ADMISSION_RECOVERY_MS),
        });
      } catch {
        // The stream is already bounded locally. Cancellation is best effort;
        // the agent's own operation deadline remains the final containment.
      }
    }
  }
}

export async function executeAndWait<K extends OpsOperationKind>(
  client: ApiOpsClient,
  operation: Extract<OpsOperation, { kind: K }>,
  operationKey: string,
  options: WaitForOpsResultOptions = {},
): Promise<OpsResultFor<K>> {
  throwIfAborted(options.signal);
  try {
    const submitted = await submitOpsOperationWithRecovery(client, operation, operationKey, {
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    if (submitted.execution === "sync") return submitted.value;
    return await waitForOpsResult(client, operation.kind, submitted, options);
  } catch (error) {
    translateError(error);
  }
}

export async function submitOpsOperationWithRecovery<K extends OpsOperationKind>(
  client: ApiOpsClient,
  operation: Extract<OpsOperation, { kind: K }>,
  operationKey: string,
  options: {
    signal?: AbortSignal;
    admissionAlreadyAttempted?: boolean;
    recoveryTimeoutMs?: number;
  } = {},
): Promise<OpsSubmitResult<K>> {
  let firstError: unknown;
  if (!options.admissionAlreadyAttempted) {
    throwIfAborted(options.signal);
    try {
      return await client.execute(operation, { operationKey, signal: options.signal });
    } catch (error) {
      firstError = error;
    }
  } else {
    firstError = new DOMException("Aborted", "AbortError");
  }
  {
    const error = firstError;
    if (!isTransientTransportError(error)) translateError(error);
    const recoveryTimeoutMs = options.recoveryTimeoutMs ?? 35_000;
    validatePositiveBounded(recoveryTimeoutMs, 35_000, "admission recovery timeout");
    const recoverySignal = AbortSignal.timeout(recoveryTimeoutMs);
    for (;;) {
      try {
        const status = await client.lookup(operation, operationKey, {
          signal: recoverySignal,
        });
        return {
          execution: "async",
          operationId: status.operationId,
          operationKey: status.operationKey,
          kind: operation.kind,
          state: status.state,
        } as OpsSubmitResult<K>;
      } catch (lookupError) {
        const lookupClass = errorClass(lookupError);
        if (lookupClass !== "not_found" && !isTransientTransportError(lookupError)) {
          translateError(lookupError);
        }
        if (recoverySignal.aborted) throw new ApiOpsError("timeout");
        try {
          await defaultSleep(250, recoverySignal);
        } catch {
          throw new ApiOpsError("timeout");
        }
      }
    }
  }
}
