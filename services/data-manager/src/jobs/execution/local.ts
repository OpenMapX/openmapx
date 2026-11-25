import type {
  DataExecutionInput,
  DataExecutionStatus,
  LocalDataExecutionKind,
} from "@openmapx/core/data-manager-contracts";
import type postgres from "postgres";
import type { DataExecutionReceiver, DataJobActor } from "./api.js";

type LocalInput = Extract<
  DataExecutionInput,
  { kind: Exclude<LocalDataExecutionKind, "generation-link"> }
>;
let receiver: Pick<DataExecutionReceiver, "runLocal"> | undefined;
/** Installed once by the assembled service before routes, cron or startup work. */
export function installLocalDataExecutions(value: Pick<DataExecutionReceiver, "runLocal">): void {
  receiver = value;
}
/** Admits `work` as a durable data execution of `input`'s kind and returns once
 * it is admitted; `completion` settles when the execution is terminal. The work
 * gets the execution's database handle, whose queries cancelling it cancels. */
export async function startLocalDataExecution<T>(
  input: LocalInput,
  work: (sql: postgres.Sql) => Promise<T>,
  actor: DataJobActor,
): Promise<{ status: DataExecutionStatus; completion: Promise<T> }> {
  if (!receiver)
    throw Object.assign(Error("Durable data receiver is unavailable"), { statusCode: 503 });
  return receiver.runLocal(input, work, actor);
}
/** Runs `work` as a durable data execution and resolves with its value. */
export async function runLocalDataExecution<T>(
  input: LocalInput,
  work: (sql: postgres.Sql) => Promise<T>,
  actor: DataJobActor,
): Promise<T> {
  return (await startLocalDataExecution(input, work, actor)).completion;
}
