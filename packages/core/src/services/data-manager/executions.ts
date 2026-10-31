import {
  type DataExecutionIdentity,
  type DataExecutionStatus,
  dataExecutionIdentitySchema,
  dataExecutionStatusSchema,
  isDataExecutionTerminal,
} from "./contracts/executions";
import { cancelDataExecution, getDataExecution } from "./generated/data-manager.generated";
import { type DataManagerTransport, unwrapDataManagerResponse } from "./transport";
export class DataExecutionObservationPending extends Error {
  constructor(
    readonly identity: DataExecutionIdentity,
    readonly reason: "transport" | "observer_deadline" | "interrupted",
  ) {
    super(`Data execution observation pending (${reason})`);
    this.name = "DataExecutionObservationPending";
  }
}
export function matchDataExecutionIdentity(
  identity: DataExecutionIdentity,
  value: unknown,
): DataExecutionStatus {
  dataExecutionIdentitySchema.parse(identity);
  const status = dataExecutionStatusSchema.parse(value);
  if (
    status.id !== identity.id ||
    status.operationKey !== identity.operationKey ||
    status.fingerprint !== identity.fingerprint
  )
    throw Error("Data execution receipt identity conflict");
  return status;
}
/** Observation owns only its GETs. Its deadline/abort never cancels work. */
export async function observeDataExecution(
  identity: DataExecutionIdentity,
  options: {
    transport: DataManagerTransport;
    signal?: AbortSignal;
    observerDeadlineAt: number;
    onProgress?: (status: DataExecutionStatus) => void;
  },
): Promise<DataExecutionStatus> {
  dataExecutionIdentitySchema.parse(identity);
  if (!Number.isSafeInteger(options.observerDeadlineAt) || options.observerDeadlineAt < 0)
    throw Error("Invalid observer deadline");
  const remaining = options.observerDeadlineAt - Date.now();
  if (remaining <= 0) throw new DataExecutionObservationPending(identity, "observer_deadline");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.min(remaining, 2147483647));
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  try {
    for (;;) {
      signal.throwIfAborted();
      const status = matchDataExecutionIdentity(
        identity,
        unwrapDataManagerResponse(
          await getDataExecution(identity.id, { transport: options.transport, signal }),
        ),
      );
      options.onProgress?.(status);
      if (isDataExecutionTerminal(status)) return status;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(wait);
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        const wait = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 250);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  } catch (error) {
    if (error instanceof DataExecutionObservationPending) throw error;
    throw new DataExecutionObservationPending(
      identity,
      options.signal?.aborted
        ? "interrupted"
        : deadline.signal.aborted || Date.now() >= options.observerDeadlineAt
          ? "observer_deadline"
          : "transport",
    );
  } finally {
    clearTimeout(timer);
  }
}
/** Explicit backend intent, independent of any retired progress reader. */
export async function requestDataExecutionCancellation(
  identity: DataExecutionIdentity,
  options: { transport: DataManagerTransport; signal?: AbortSignal },
): Promise<DataExecutionStatus> {
  dataExecutionIdentitySchema.parse(identity);
  try {
    const result = await cancelDataExecution(
      identity.id,
      { operationKey: identity.operationKey, fingerprint: identity.fingerprint },
      options,
    );
    return matchDataExecutionIdentity(identity, unwrapDataManagerResponse(result));
  } catch (error) {
    if (error instanceof DataExecutionObservationPending) throw error;
    throw new DataExecutionObservationPending(
      identity,
      options.signal?.aborted ? "interrupted" : "transport",
    );
  }
}
export type {
  DataChildAttempt,
  DataExecutionIdentity,
  DataExecutionInput,
  DataExecutionMetrics,
  DataExecutionResult,
  DataExecutionStatus,
} from "./contracts/executions";
