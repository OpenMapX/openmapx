import type { IntegrationContext } from "@openmapx/integration-framework";

/**
 * Resolve a url-backed provider's endpoint with the canonical cascade shared by
 * the simple geocoding sub-providers (nominatim, photon, pelias):
 *
 *   service registry → manifest `config.endpoint` → hard-coded fallback.
 *
 * The `setXxxUrl(...)` side-effect call stays explicit in each provider's
 * `setup`; only this resolution expression is shared.
 */
export function resolveEndpoint(
  ctx: IntegrationContext,
  serviceId: string,
  fallback: string,
): string {
  return (
    ctx.getRequiredService(serviceId)?.url ??
    (ctx.config.endpoint as string | undefined) ??
    fallback
  );
}
