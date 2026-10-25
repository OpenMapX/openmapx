import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import type { DataExecutionContext } from "./runtime.js";

const workers = new AsyncLocalStorage<DataExecutionContext>();
export function dataExecutionWorkerContext(): DataExecutionContext | undefined {
  return workers.getStore();
}
const settlements = new AsyncLocalStorage<AbortSignal>();
export function withDataSqlSettlement<T>(run: () => Promise<T>): Promise<T> {
  return settlements.run(AbortSignal.timeout(30000), run);
}
export function withDataExecutionScope<T>(
  context: DataExecutionContext,
  run: () => Promise<T>,
): Promise<T> {
  return workers.run(context, run);
}
export function dataWorkerSignal(signal?: AbortSignal): AbortSignal | undefined {
  const owned = settlements.getStore() ?? workers.getStore()?.signal;
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
 * keeps publication unknown; a verified PostgreSQL rollback restores the prior
 * publication receipt. Only the static worker consumers call this local scope. */
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
/** Awaited PostgreSQL requests are canceled on the actual connection. Awaiting
 * their rejection/rollback contains the request; observer disconnection never
 * enters this scope. Durable ownership rows use the independent raw pool. */
function ownedQuery<T>(query: T): T {
  if (
    !query ||
    typeof query !== "object" ||
    !("cancel" in query) ||
    typeof query.cancel !== "function"
  )
    return query;
  const cancel = query.cancel.bind(query);
  return new Proxy(query, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "then" || typeof value !== "function")
        return typeof value === "function" ? value.bind(target) : value;
      return (
        resolved?: ((value: unknown) => unknown) | null,
        rejected?: ((reason: unknown) => unknown) | null,
      ) => {
        const signal = dataWorkerSignal();
        if (signal?.aborted) return Promise.reject(signal.reason).then(resolved, rejected);
        const abort = () => {
          void Promise.resolve(cancel()).catch(() => {});
        };
        signal?.addEventListener("abort", abort, { once: true });
        const pending = Reflect.apply(value, target, []);
        return Promise.resolve(pending)
          .finally(() => signal?.removeEventListener("abort", abort))
          .then(resolved, rejected);
      };
    },
  });
}
export function withDataSqlCancellation<T extends postgres.Sql | postgres.TransactionSql>(
  sql: T,
): T {
  return new Proxy(sql, {
    apply(target, thisArg, args) {
      return ownedQuery(Reflect.apply(target, thisArg, args));
    },
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "begin")
        return (...args: unknown[]) => {
          if (!workers.getStore()) return Reflect.apply(value, target, args);
          const callback = args.find((arg) => typeof arg === "function");
          if (typeof callback !== "function") throw Error("Data transaction callback required");
          const reserve = Reflect.get(target, "reserve");
          if (typeof reserve !== "function")
            throw Error("Owned transaction requires its own connection");
          return (async () => {
            const connection = await Reflect.apply(reserve, target, []),
              options = typeof args[0] === "string" ? args[0].replace(/[^a-z ]/gi, "") : "";
            let commitAttempted = false,
              releasable = false;
            let originalBackend: unknown;
            try {
              originalBackend = await ownedQuery(
                connection.unsafe(
                  "SELECT pg_backend_pid() AS pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()",
                ),
              );
              await ownedQuery(connection.unsafe(`BEGIN ${options}`));
              const pending = Reflect.apply(callback, undefined, [
                withDataSqlCancellation(connection),
              ]);
              const result = await (Array.isArray(pending) ? Promise.all(pending) : pending);
              // Publication authority was checked before BEGIN. The physical
              // target remains owned; the actual connection is cancelable through
              // COMMIT, without acquiring filesystem writers under DB locks.
              dataWorkerSignal()?.throwIfAborted();
              const execution = workers.getStore()?.execution;
              if (execution && Date.now() >= execution.deadlineAt)
                throw new DOMException("Execution deadline elapsed", "AbortError");
              commitAttempted = true;
              await ownedQuery(connection.unsafe("COMMIT"));
              releasable = true;
              return result;
            } catch (error) {
              try {
                const after = await withDataSqlSettlement(async () => {
                  await ownedQuery(connection.unsafe("ROLLBACK"));
                  return ownedQuery(
                    connection.unsafe(
                      "SELECT pg_backend_pid() AS pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()",
                    ),
                  );
                });
                if (JSON.stringify(after) === JSON.stringify(originalBackend)) {
                  releasable = true;
                  if (!commitAttempted) throw new DataSqlRolledBack(error);
                }
              } catch (rollback) {
                if (rollback instanceof DataSqlRolledBack) throw rollback;
              }
              await workers.getStore()?.checkpoint({ publication: "unknown" });
              throw error;
            } finally {
              // An uncertain transaction never returns its connection for reuse.
              if (releasable) connection.release();
            }
          })();
        };
      if (property === "reserve")
        return (...args: unknown[]) =>
          Promise.resolve(Reflect.apply(value, target, args)).then((connection) =>
            withDataSqlCancellation(connection),
          );
      return (...args: unknown[]) => ownedQuery(Reflect.apply(value, target, args));
    },
  });
}
