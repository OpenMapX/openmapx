import { extensionSchemaName } from "@openmapx/core/component-id";
import {
  type DatabaseClient,
  type DatabaseTransaction,
  type IntegrationManifest,
  type Logger,
  ProviderTimeoutError,
} from "@openmapx/integration-framework";
import type { Sql } from "postgres";
import { type IntegrationScope, ignoredAfterUnload } from "./integration-scope";

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
const SET_SEARCH_PATH = "select set_config('search_path', $1, true)";

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
  /** Calls made once `scope` is revoked do nothing, as other context methods do. */
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

type Statement = Promise<unknown> & { cancel(): unknown };

function send(client: Pick<Sql, "unsafe">, query: string, params?: unknown[]): Statement {
  return (params
    ? client.unsafe(query, params as never[])
    : client.unsafe(query)) as unknown as Statement;
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && codes.includes(code);
}

/**
 * Nobody awaits work an unloaded integration left behind, so a rejection
 * would stop the API; a call it makes gets a promise that never settles.
 */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * An integration's `ctx.db`. `execute` runs on the request-path pool and the
 * caller's signal cancels its statement; a statement the server ends at its
 * timeout rejects as a provider timeout, so the provider degrades like any
 * slow upstream instead of failing the request. `transaction` runs on its own
 * pool. With `schema`, both methods first point `search_path` at it.
 */
export function createIntegrationDb(
  pools: IntegrationDbPools,
  options: IntegrationDbOptions = {},
): DatabaseClient {
  const { schema, revocation } = options;
  const searchPath = schema === undefined ? undefined : `"${schema}", public`;
  const ignored = (method: string) =>
    revocation !== undefined && ignoredAfterUnload(revocation.scope, method, revocation.log);

  async function execute<T = unknown>(
    query: string,
    params?: unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    let current: Statement | undefined;
    const onAbort = () => current?.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (searchPath === undefined) {
        current = send(pools.requests, query, params);
        return (await current) as T;
      }
      return (await pools.requests.begin(async (sql) => {
        current = send(sql, SET_SEARCH_PATH, [searchPath]);
        await current;
        signal?.throwIfAborted();
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
   * The client-side deadline ends the transaction itself: it cancels the
   * running statement and makes the callback's promise reject, so postgres.js
   * rolls back and frees the connection at once, even while the callback still
   * awaits something else. The server's statement and idle-in-transaction
   * timeouts end it as well should this process stall.
   */
  function transaction<T>(
    fn: (tx: DatabaseTransaction) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (ignored("db.transaction")) return never();
    const timeoutMs = transactionTimeoutMs(options?.timeoutMs);
    const running = new Set<Statement>();
    let ending: { reason: unknown } | undefined;
    let endCallback!: (reason: unknown) => void;
    const ended = new Promise<never>((_resolve, reject) => {
      endCallback = reject;
    });
    ended.catch(() => {});
    // Set when the callback went on after its integration was unloaded: the
    // transaction rolls back and the call, like the callback's statement,
    // never settles.
    let abandoned = false;
    const end = (reason: unknown) => {
      if (ending) return;
      ending = { reason };
      endCallback(reason);
      for (const statement of running) statement.cancel();
    };
    const track = (statement: Statement) => {
      running.add(statement);
      const forget = () => running.delete(statement);
      statement.then(forget, forget);
      return statement;
    };

    const work = pools.transactions.begin((sql) => {
      if (ending) return Promise.reject(ending.reason);
      const tx: DatabaseTransaction = {
        async execute<R = unknown>(query: string, params?: unknown[]): Promise<R> {
          if (ignored("db.transaction.execute")) {
            abandoned = true;
            end(new Error("The integration was unloaded"));
            return never();
          }
          if (ending) throw ending.reason;
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
        await track(send(sql, SET_TRANSACTION_TIMEOUTS, [String(timeoutMs)]));
        if (searchPath !== undefined) await track(send(sql, SET_SEARCH_PATH, [searchPath]));
        return fn(tx);
      };
      return Promise.race([body(), ended]);
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeout = new ProviderTimeoutError();
        end(timeout);
        if (!abandoned) reject(timeout);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      work.then(
        (value) => {
          clearTimeout(timer);
          if (!abandoned) resolve(value as T);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (abandoned) return;
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
      return ignored("db.execute") ? never() : execute<T>(query, params, options);
    },
    transaction,
    ...(schema === undefined ? {} : { schema }),
  };
}
