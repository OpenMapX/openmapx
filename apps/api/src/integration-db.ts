import { type DatabaseClient, ProviderTimeoutError } from "@openmapx/integration-framework";
import type { Sql } from "postgres";

/** PostgreSQL's `query_canceled`: the statement timeout ended it, or the caller cancelled it. */
const QUERY_CANCELED = "57014";

/**
 * An integration's `ctx.db` on `client`. The caller's signal cancels the
 * statement. A statement the server ends at its timeout rejects as a provider
 * timeout, so the provider degrades like any slow upstream instead of failing
 * the request.
 */
export function createIntegrationDb(client: Pick<Sql, "unsafe">): DatabaseClient {
  return {
    async execute<T = unknown>(
      query: string,
      params?: unknown[],
      options?: { signal?: AbortSignal },
    ): Promise<T> {
      options?.signal?.throwIfAborted();
      const pending = params ? client.unsafe(query, params as never[]) : client.unsafe(query);
      const onAbort = () => pending.cancel();
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return (await pending) as T;
      } catch (error) {
        if (
          !options?.signal?.aborted &&
          (error as { code?: unknown } | null)?.code === QUERY_CANCELED
        ) {
          throw new ProviderTimeoutError({ cause: error });
        }
        throw error;
      } finally {
        options?.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
