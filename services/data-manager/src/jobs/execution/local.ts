import type {
  DataExecutionInput,
  DataExecutionStatus,
  LocalDataExecutionKind,
} from "@openmapx/core/data-manager-contracts";
import type { DataExecutionReceiver } from "./api.js";

type LocalInput = Extract<DataExecutionInput, { kind: LocalDataExecutionKind }>;
let receiver: Pick<DataExecutionReceiver, "runLocal"> | undefined;
/** Installed once by the assembled service before routes, cron or startup work. */
export function installLocalDataExecutions(value: Pick<DataExecutionReceiver, "runLocal">): void {
  receiver = value;
}
/** Admits `work` as a durable data execution of `input`'s kind and returns once
 * it is admitted; `completion` settles when the execution is terminal. */
export async function startLocalDataExecution<T>(
  input: LocalInput,
  work: () => Promise<T>,
  options?: { triggeredBy?: string },
): Promise<{ status: DataExecutionStatus; completion: Promise<T> }> {
  if (!receiver)
    throw Object.assign(Error("Durable data receiver is unavailable"), { statusCode: 503 });
  return receiver.runLocal(input, work, options);
}
/** Runs `work` as a durable data execution and resolves with its value. */
export async function runLocalDataExecution<T>(
  input: LocalInput,
  work: () => Promise<T>,
  options?: { triggeredBy?: string },
): Promise<T> {
  return (await startLocalDataExecution(input, work, options)).completion;
}
