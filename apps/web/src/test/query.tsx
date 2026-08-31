import { createQueryWrapper, createTestQueryClient } from "@openmapx/core/test/query";
import type { QueryClient } from "@tanstack/react-query";
import { type RenderHookOptions, renderHook } from "@testing-library/react";

export { createQueryWrapper, createTestQueryClient };

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
