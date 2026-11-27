import { AsyncLocalStorage } from "node:async_hooks";
import { extensionSchemaName } from "@openmapx/core/component-id";
import {
  type DatabaseClient,
  type DatabaseTransaction,
  type IntegrationManifest,
  type Logger,
  ProviderTimeoutError,
} from "@openmapx/integration-framework";
import type { Sql } from "postgres";
import { type IntegrationScope, warnAfterUnload } from "./integration-scope";

/** PostgreSQL's `query_canceled`: the statement timeout ended it, or the caller cancelled it. */
const QUERY_CANCELED = "57014";

/** PostgreSQL's code for a session it ended after idling in a transaction past its timeout. */
const IDLE_IN_TRANSACTION_TIMEOUT = "25P03";

const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;
const MIN_TRANSACTION_TIMEOUT_MS = 1_000;
const MAX_TRANSACTION_TIMEOUT_MS = 900_000;

// `SET LOCAL` takes no bind parameter; `set_config(..., true)` is its
// parameterised form and ends with the transaction as well.
const SET_TRANSACTION_TIMEOUTS =
  "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)";
// A schema missing from `search_path` is skipped without an error, so an
// unqualified name would land in `public`; the same statement says whether the
// schema is there.
const SET_SEARCH_PATH =
  "select set_config('search_path', $1, true), to_regnamespace($2) is not null as present";

/**
 * How often each integration's data has been removed. A client remembers the
 * count it was created with and refuses every call once it changes, so code
 * still running after its data was removed cannot write anywhere else; the
 * client of the next installation starts from the new count.
 */
const dataRemovals = new Map<string, number>();

/**
 * Refuses, from now on, every `ctx.db` call of the clients `integrationId`
 * has so far. Called as its data is removed.
 */
export function stopIntegrationDatabase(integrationId: string): void {
  dataRemovals.set(integrationId, (dataRemovals.get(integrationId) ?? 0) + 1);
}

/** The pools `ctx.db` runs on. */
export interface IntegrationDbPools {
  /** The request-path pool with its short statement timeout; `execute` runs here. */
  readonly requests: Pick<Sql, "unsafe" | "begin">;
  /** The small pool only transactions use, so a long one cannot starve requests. */
  readonly transactions: Pick<Sql, "begin">;
}

export interface IntegrationDbOptions {
  /** The schema the integration owns; derived with `extensionSchemaName` only. */
  readonly schema?: string;
  /** Whose client this is, so removing that integration's data stops it. */
  readonly integrationId?: string;
  /** Calls made once `scope` is revoked are logged once per method and still run. */
  readonly revocation?: { readonly scope: IntegrationScope; readonly log: Logger };
}

/**
 * Whether an integration gets `ctx.db`, and the schema it owns: `undefined`
 * when it neither requires PostGIS nor ships migrations, no `schema` when it
 * only requires PostGIS.
 */
export function integrationDbAccess(
  manifest: Pick<IntegrationManifest, "id" | "requires" | "database">,
): { schema?: string } | undefined {
  if (manifest.database?.migrations === true) {
    return { schema: extensionSchemaName(manifest.id) };
  }
  return manifest.requires?.some((requirement) => requirement.service === "postgis")
    ? {}
    : undefined;
}

/** The declared transaction timeout, clamped to what the host allows. */
function transactionTimeoutMs(requested: number | undefined): number {
  if (typeof requested !== "number" || Number.isNaN(requested)) {
    return DEFAULT_TRANSACTION_TIMEOUT_MS;
  }
  return Math.min(
    MAX_TRANSACTION_TIMEOUT_MS,
    Math.max(MIN_TRANSACTION_TIMEOUT_MS, Math.trunc(requested)),
  );
}

const NESTED_TRANSACTION =
  "Nested transactions are not supported; use the transaction passed to the callback";

/** A postgres.js query in flight, which can ask the server to cancel it. */
export type Statement = Promise<unknown> & { cancel(): Promise<unknown> };

/** Sends `query`; without `params` postgres.js uses the simple protocol, which allows several statements. */
export function send(client: Pick<Sql, "unsafe">, query: string, params?: unknown[]): Statement {
  return (params
    ? client.unsafe(query, params as never[])
    : client.unsafe(query)) as unknown as Statement;
}

/**
 * Asks the server to cancel `statement`. postgres.js rejects the request when
 * its cancel socket fails, for example while the database is unreachable;
 * the statement's own outcome reports what matters, and an unhandled
 * rejection would stop the API.
 */
export function cancelQuietly(statement: Statement | undefined): void {
  if (!statement) return;
  try {
    Promise.resolve(statement.cancel()).catch(() => {});
  } catch {
    // A cancel that throws at once changes nothing either.
  }
}

export function hasCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && codes.includes(code);
}

/** The transaction's deadline passed before it had a connection. */
class ConnectionWaitTimeoutError extends ProviderTimeoutError {
  constructor() {
    super();
    this.message = "provider deadline exceeded while waiting for a database connection";
  }
}

/**
 * An integration's `ctx.db`. `execute` runs on the request-path pool and the
 * caller's signal cancels its statement; a statement the server ends at its
 * timeout rejects as a provider timeout, so the provider degrades like any
 * slow upstream instead of failing the request. `transaction` runs on its own
 * pool. With `schema`, both methods first point `search_path` at it.
 *
 * Calls made once the integration's scope is revoked are logged once per
 * method and still run: a shutdown handler that awaits one must finish, and
 * the statement and transaction timeouts bound the work.
 */
export function createIntegrationDb(
  pools: IntegrationDbPools,
  options: IntegrationDbOptions = {},
): DatabaseClient {
  const { schema, revocation, integrationId } = options;
  const searchPath = schema === undefined ? undefined : `"${schema}", public`;
  const warnLate = (method: string) => {
    if (revocation) warnAfterUnload(revocation.scope, method, revocation.log);
  };
  const removalsAtCreation =
    integrationId === undefined ? 0 : (dataRemovals.get(integrationId) ?? 0);
  const assertDataKept = () => {
    if (
      integrationId !== undefined &&
      (dataRemovals.get(integrationId) ?? 0) !== removalsAtCreation
    )
      throw new Error(
        `The data of integration ${integrationId} was removed; its database calls are refused until it is installed again`,
      );
  };
  const pointAtSchema = async (sql: Pick<Sql, "unsafe">, track: (s: Statement) => Statement) => {
    const [row] = (await track(send(sql, SET_SEARCH_PATH, [searchPath, schema]))) as Array<{
      present?: boolean;
    }>;
    if (row?.present !== true) throw new Error(`Schema ${schema} does not exist`);
  };
  // Set inside a transaction's callback while the transaction is open.
  const insideTransaction = new AsyncLocalStorage<{ open: boolean }>();
  // Settles once the integration's last transaction has released its connection.
  let queue: Promise<void> = Promise.resolve();

  async function execute<T = unknown>(
    query: string,
    params?: unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    assertDataKept();
    let current: Statement | undefined;
    const onAbort = () => cancelQuietly(current);
    signal?.addEventListener("abort", onAbort, { once: true });
    const remember = (statement: Statement) => {
      current = statement;
      return statement;
    };
    try {
      if (searchPath === undefined) {
        current = send(pools.requests, query, params);
        return (await current) as T;
      }
      return (await pools.requests.begin(async (sql) => {
        await pointAtSchema(sql, remember);
        signal?.throwIfAborted();
        assertDataKept();
        current = send(sql, query, params);
        return await current;
      })) as T;
    } catch (error) {
      if (!signal?.aborted && hasCode(error, QUERY_CANCELED)) {
        throw new ProviderTimeoutError({ cause: error });
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The integration's transactions run one at a time, in the order they were
   * called, so one integration never holds both connections of the pool all
   * extensions share; the deadline bounds the wait for its turn and for a
   * connection as well. Until the callback has resolved, the client-side
   * deadline ends the transaction itself: it cancels the running statement
   * and makes the callback's promise reject, so postgres.js rolls back and
   * frees the connection at once, even while the callback still awaits
   * something else. Once the callback has resolved, the COMMIT postgres.js
   * sends decides the outcome, bounded by the transaction's statement
   * timeout. The server's statement and idle-in-transaction timeouts end the
   * transaction as well should this process stall.
   */
  function transaction<T>(
    fn: (tx: DatabaseTransaction) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    // The call would wait for the very transaction it was made in.
    if (insideTransaction.getStore()?.open) return Promise.reject(new Error(NESTED_TRANSACTION));
    try {
      assertDataKept();
    } catch (error) {
      return Promise.reject(error);
    }
    warnLate("db.transaction");
    const timeoutMs = transactionTimeoutMs(options?.timeoutMs);
    const previous = queue;
    let leaveQueue!: () => void;
    queue = new Promise<void>((resolve) => {
      leaveQueue = resolve;
    });
    const inside = { open: true };
    let phase: "waiting" | "running" | "committing" = "waiting";
    const running = new Set<Statement>();
    let ending: { reason: unknown } | undefined;
    let endCallback!: (reason: unknown) => void;
    const ended = new Promise<never>((_resolve, reject) => {
      endCallback = reject;
    });
    ended.catch(() => {});
    const end = (reason: unknown) => {
      if (ending) return;
      ending = { reason };
      endCallback(reason);
      for (const statement of running) cancelQuietly(statement);
    };
    const track = (statement: Statement) => {
      running.add(statement);
      const forget = () => running.delete(statement);
      statement.then(forget, forget);
      return statement;
    };

    const work = previous.then(() => {
      // Ended while waiting for its turn: it never asks for a connection.
      if (ending) return undefined;
      return pools.transactions.begin((sql) => {
        if (ending) return Promise.reject(ending.reason);
        phase = "running";
        const tx: DatabaseTransaction = {
          async execute<R = unknown>(query: string, params?: unknown[]): Promise<R> {
            warnLate("db.transaction.execute");
            if (ending) throw ending.reason;
            assertDataKept();
            try {
              return (await track(send(sql, query, params))) as R;
            } catch (error) {
              throw hasCode(error, QUERY_CANCELED)
                ? new ProviderTimeoutError({ cause: error })
                : error;
            }
          },
        };
        const body = async () => {
          assertDataKept();
          await track(send(sql, SET_TRANSACTION_TIMEOUTS, [String(timeoutMs)]));
          if (searchPath !== undefined) await pointAtSchema(sql, track);
          const result = await insideTransaction.run(inside, () => fn(tx));
          phase = "committing";
          return result;
        };
        return Promise.race([body(), ended]);
      });
    });
    const leave = () => {
      inside.open = false;
      leaveQueue();
    };
    work.then(leave, leave);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (phase === "committing") return;
        const timeout =
          phase === "waiting" ? new ConnectionWaitTimeoutError() : new ProviderTimeoutError();
        end(timeout);
        reject(timeout);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(
            hasCode(error, QUERY_CANCELED, IDLE_IN_TRANSACTION_TIMEOUT)
              ? new ProviderTimeoutError({ cause: error })
              : error,
          );
        },
      );
    });
  }

  return {
    execute<T = unknown>(
      query: string,
      params?: unknown[],
      options?: { signal?: AbortSignal },
    ): Promise<T> {
      warnLate("db.execute");
      return execute<T>(query, params, options);
    },
    transaction,
    ...(schema === undefined ? {} : { schema }),
  };
}
