import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Reusable test harness for the TanStack Query hooks in `@openmapx/core`.
 *
 * Tests under `packages/core/src/hooks/**` run in the `web` (jsdom) Vitest
 * project (see the root `vitest.config.ts`), so `renderHook` from
 * `@testing-library/react` works. Wrap the hook in `createQueryWrapper()` and
 * mock the API client (`vi.spyOn(apiClient, "get")`) the hook fetches through.
 *
 * `retry: false` makes failures surface immediately; `gcTime`/`staleTime` 0
 * keeps queries from leaking across tests. Use a fresh client per test.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Wrapper component that provides a fresh QueryClient — pass to `renderHook`. */
export function createQueryWrapper(client: QueryClient = createTestQueryClient()) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
