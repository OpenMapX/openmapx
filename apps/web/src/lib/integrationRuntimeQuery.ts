import type { QueryClient } from "@tanstack/react-query";

export const INTEGRATION_METADATA_REFRESH_MS = 30_000;

function normalizeApiBase(apiUrl: string): string {
  return apiUrl.replace(/\/$/, "");
}

export function integrationRuntimeQueryKey(apiUrl: string) {
  return ["integrations", normalizeApiBase(apiUrl)] as const;
}

export function invalidateIntegrationRuntime(
  queryClient: QueryClient,
  apiUrl: string,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: integrationRuntimeQueryKey(apiUrl) });
}
