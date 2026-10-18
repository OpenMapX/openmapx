import { createApiClient } from "./client";
import type { IntegrationsResponse } from "./contracts/runtime-metadata";
import { getApiIntegrations } from "./generated/runtime-metadata.generated";
import { serverApiUrl } from "./server-url";

/** Live legal-page metadata: one validated snapshot, never seeded by the build cache. */
export async function fetchIntegrationMetadata(): Promise<IntegrationsResponse | null> {
  try {
    const result = await getApiIntegrations(undefined, {
      client: createApiClient({ baseUrl: serverApiUrl(), credentials: "omit" }),
      cache: "no-store",
    });
    return result.status === 200 ? result.data : null;
  } catch {
    // Legal pages retain their established empty tables when the API is unavailable.
    return null;
  }
}
