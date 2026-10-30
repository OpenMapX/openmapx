import {
  platformEndpointServiceId,
  type ResolvedPlatformEndpoint,
  resolvePlatformEndpoint,
} from "@openmapx/core";
import type { PlatformEndpointId } from "@openmapx/extension-contracts";

export interface PlatformEndpointIntegration {
  manifest: { endpointConfigKeys?: Record<string, string> };
  /** The integration's resolved configuration. */
  config: Record<string, unknown>;
}

/** A `requires:` entry as the host resolved it. */
export type RequiredServiceLookup = (
  serviceId: string,
) => { url: string; enabled: boolean } | null | undefined;

/**
 * The instance of platform endpoint `id` an integration uses: its enabled
 * self-hosted requirement, then its own URL setting (`endpointConfigKeys`),
 * then the operator's URL, then the public default. The host answers
 * `ctx.resolvePlatformEndpoint` and resolves `${endpoint:<id>}` health checks
 * with this, so an integration's probe and its queries reach the same instance.
 */
export function resolveIntegrationPlatformEndpoint(
  integration: PlatformEndpointIntegration,
  requiredService: RequiredServiceLookup,
  id: PlatformEndpointId,
  env?: Record<string, string | undefined>,
): ResolvedPlatformEndpoint | null {
  const serviceId = platformEndpointServiceId(id);
  const service = serviceId ? requiredService(serviceId) : null;
  const configKey = integration.manifest.endpointConfigKeys?.[id];
  return resolvePlatformEndpoint(
    id,
    {
      selfHostedUrl: service?.enabled ? service.url : null,
      configuredUrl: configKey ? integration.config[configKey] : undefined,
    },
    env,
  );
}
