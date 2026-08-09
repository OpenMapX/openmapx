import { PERSONAL_TIMELINE_QUERY_KEY } from "@openmapx/core";
import { defaultShouldDehydrateMutation, type QueryClient } from "@tanstack/react-query";

/**
 * Invalidates the old cache format that could contain paused timeline mutation
 * variables, including API keys, through TanStack's default mutation policy.
 */
export const PERSONAL_TIMELINE_CACHE_BUSTER = "v2-no-personal-timeline-mutations";

export function isPersonalTimelineMutationKey(key: readonly unknown[] | undefined): boolean {
  return key?.[0] === PERSONAL_TIMELINE_QUERY_KEY[0];
}

export function shouldDehydrateOpenMapXMutation(
  mutation: Parameters<typeof defaultShouldDehydrateMutation>[0],
): boolean {
  return (
    !isPersonalTimelineMutationKey(mutation.options.mutationKey) &&
    defaultShouldDehydrateMutation(mutation)
  );
}

/** Defense in depth for any restored cache not rejected by its buster. */
export function removePersonalTimelineMutations(queryClient: QueryClient): void {
  const mutationCache = queryClient.getMutationCache();
  for (const mutation of mutationCache.findAll({
    mutationKey: PERSONAL_TIMELINE_QUERY_KEY,
    exact: false,
  })) {
    mutationCache.remove(mutation);
  }
}
