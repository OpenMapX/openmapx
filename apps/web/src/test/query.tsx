import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderHookOptions, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * A QueryClient tuned for tests: no retries (failures surface immediately) and
 * no caching across tests (gcTime/staleTime 0). Use a fresh one per test.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Wrapper component that provides a QueryClient — for `renderHook`/`render`. */
export function createQueryWrapper(client: QueryClient = createTestQueryClient()) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * `renderHook` with a QueryClientProvider already wired — the standard way to
 * test the ~78 TanStack Query hooks in `@openmapx/core`. Returns the usual
 * renderHook result plus the `queryClient` for direct assertions.
 */
export function renderHookWithQuery<Result, Props>(
  hook: (initialProps: Props) => Result,
  options?: Omit<RenderHookOptions<Props>, "wrapper"> & { queryClient?: QueryClient },
) {
  const queryClient = options?.queryClient ?? createTestQueryClient();
  const result = renderHook(hook, { wrapper: createQueryWrapper(queryClient), ...options });
  return { ...result, queryClient };
}
