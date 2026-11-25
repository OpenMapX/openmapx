import { DATA_JOB_TERMINAL_STATUSES } from "../jobs/vocabulary";
import type { ExecutionRef } from "../ops/execution-ref";
import {
  type DataExecutionStatus,
  dataExecutionStatusSchema,
} from "../services/data-manager/contracts/executions";
import { lookupDataExecution } from "../services/data-manager/generated/data-manager.generated";
import {
  type DataManagerTransport,
  unwrapDataManagerResponse,
} from "../services/data-manager/transport";

const TERMINAL = new Set<string>(DATA_JOB_TERMINAL_STATUSES);

/**
 * Checks that `status` is the terminal of exactly `execution` with a known
 * publication. Anything else is an unknown outcome and never releases.
 */
export function assertDataManagerTerminal(
  execution: ExecutionRef,
  status: DataExecutionStatus,
): DataExecutionStatus {
  const parsed = dataExecutionStatusSchema.parse(status);
  if (
    parsed.id !== execution.executionId ||
    parsed.operationKey !== execution.operationKey ||
    parsed.fingerprint !== execution.fingerprint ||
    !TERMINAL.has(parsed.status) ||
    parsed.publication === "unknown"
  )
    throw Error("Exact terminal data-manager status required");
  return parsed;
}

/**
 * Data-manager's terminal status of `execution`, read over its authenticated
 * route on every call; nothing is copied. A missing execution is unknown.
 */
export async function readDataManagerTerminal(
  execution: ExecutionRef,
  transport: DataManagerTransport,
  signal?: AbortSignal,
): Promise<DataExecutionStatus> {
  const status = unwrapDataManagerResponse(
    await lookupDataExecution(execution.operationKey, { transport, signal }),
  );
  return assertDataManagerTerminal(execution, status);
}
