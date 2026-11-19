import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { DataExecutionContext } from "./runtime.js";

const workers = new AsyncLocalStorage<DataExecutionContext>();
/** How long a cancelled worker's transactions may take to roll back before their connections close. */
const SETTLEMENT_SECONDS = 30;
export function dataExecutionWorkerContext(): DataExecutionContext | undefined {
  return workers.getStore();
}
export function withDataExecutionScope<T>(
  context: DataExecutionContext,
  run: () => Promise<T>,
): Promise<T> {
  return workers.run(context, run);
}
export function dataWorkerSignal(signal?: AbortSignal): AbortSignal | undefined {
  const owned = workers.getStore()?.signal;
  return signal && owned && signal !== owned ? AbortSignal.any([signal, owned]) : (signal ?? owned);
}
export function dataWorkerDeadline(): number | undefined {
  return workers.getStore()?.execution.deadlineAt;
}
export function assertDataPublication(): void {
  workers.getStore()?.assertForward();
}
export async function retainDataPublication(): Promise<void> {
  await workers.getStore()?.checkpoint({ publication: "committed" });
}
export class DataPublicationUnknown extends Error {
  constructor(original: unknown) {
    super(original instanceof Error ? original.message : "Data publication remains unknown", {
      cause: original,
    });
  }
}
class DataSqlRolledBack extends Error {
  constructor(readonly original: unknown) {
    super("Owned database transaction rolled back", { cause: original });
  }
}
/** The marker precedes the actual live write. A lost commit/rename response
 * keeps publication unknown; a transaction that ended before its COMMIT was
 * sent restores the prior publication. Only the static worker consumers call
 * this local scope. */
export async function publishDataChange<T>(run: () => Promise<T> | T): Promise<T> {
  const context = workers.getStore();
  if (!context) return run();
  context.assertForward();
  const previous = (await context.record()).status.publication;
  await context.checkpoint({ publication: "unknown" });
  context.assertForward();
  try {
    const value = await run();
    await context.checkpoint({ publication: "committed" });
    return value;
  } catch (error) {
    if (error instanceof DataSqlRolledBack) {
      await context.checkpoint({ publication: previous });
      throw error.original;
    }
    throw new DataPublicationUnknown(error);
  }
}
/** A worker's own database connections. */
export interface CancellableSql {
  readonly sql: postgres.Sql;
  /** Ends the connections once their queries settle. */
  close(): Promise<void>;
}
/**
 * Opens a worker's database handle: a pool of its own whose connections carry
 * one application name, so the control pool can find them. When the signal
 * aborts, the handle refuses new queries and every statement running on its
 * connections is cancelled. A transaction keeps its connection to roll back,
 * for at most the settlement time; then the connection closes, which rolls it
 * back too.
 */
export function openCancellableSql(
  connect: (applicationName: string) => postgres.Sql,
  control: postgres.Sql,
  signal: AbortSignal,
): CancellableSql {
  const applicationName = `openmapx-data-worker-${randomUUID()}`,
    sql = connect(applicationName);
  const cancel = () => {
    sql.end({ timeout: SETTLEMENT_SECONDS }).catch(() => {});
    control`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name=${applicationName}`.catch(
      () => {},
    );
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  return {
    sql,
    async close() {
      signal.removeEventListener("abort", cancel);
      await sql.end({ timeout: SETTLEMENT_SECONDS });
    },
  };
}
/**
 * Runs `work` in a transaction on a connection reserved for it. Inside a
 * worker, the worker's handle cancels the transaction's statements, and
 * nothing commits once the worker was cancelled or its deadline passed. A
 * failure before COMMIT was sent rolls the transaction back, so it cannot have
 * committed: publishDataChange then restores the prior publication. A COMMIT
 * that fails or is cancelled leaves the publication unknown.
 */
export async function cancellableTransaction<T>(
  sql: postgres.Sql,
  work: (transaction: postgres.TransactionSql) => Promise<T>,
  isolation = "",
): Promise<T> {
  const context = workers.getStore();
  if (!context) return (await sql.begin(isolation, work)) as T;
  context.signal.throwIfAborted();
  let committing = false;
  try {
    return (await sql.begin(isolation, async (transaction) => {
      const result = await work(transaction);
      context.signal.throwIfAborted();
      if (Date.now() >= context.execution.deadlineAt)
        throw new DOMException("Execution deadline elapsed", "AbortError");
      committing = true;
      return result;
    })) as T;
  } catch (error) {
    if (committing) throw error;
    throw new DataSqlRolledBack(error);
  }
}
