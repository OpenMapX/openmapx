import { DEFAULT_QUERY_GC_TIME_MS } from "@openmapx/core";
import {
  type DefaultError,
  type DefaultedQueryObserverOptions,
  QueryClient,
  type QueryClientConfig,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";

const QUERY_CLIENT_CONFIG: QueryClientConfig = {
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      // IndexedDB persistence separately preserves opted-in offline map
      // data. In-memory inactive queries should not accumulate all day.
      gcTime: DEFAULT_QUERY_GC_TIME_MS,
    },
  },
};

/**
 * The client of one server render, whose queries go with the request. A
 * finite `gcTime`, the default's or a hook's own, arms a timer per query that
 * holds the query, its client and the whole request until it fires; an hour
 * of page loads then outgrew app-web's heap. `Infinity` arms none.
 */
class ServerRenderQueryClient extends QueryClient {
  override defaultQueryOptions<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options:
      | QueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey, TPageParam>
      | DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
  ): DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey> {
    return { ...super.defaultQueryOptions(options), gcTime: Infinity };
  }
}

/** The app's query client: in the browser, or for one server render. */
export function createAppQueryClient(server = typeof window === "undefined"): QueryClient {
  return server
    ? new ServerRenderQueryClient(QUERY_CLIENT_CONFIG)
    : new QueryClient(QUERY_CLIENT_CONFIG);
}
