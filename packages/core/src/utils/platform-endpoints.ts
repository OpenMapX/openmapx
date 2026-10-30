import type { HealthCheckEndpointId } from "@openmapx/extension-contracts";

export { ENDPOINT_URL_TEMPLATE, isHealthCheckEndpointId } from "@openmapx/extension-contracts";

/**
 * A platform backend that API-side clients query wherever the deployment
 * keeps it: its self-hosted service, an operator's instance, or a public one.
 */
interface PlatformEndpointDefinition {
  /** The built-in service that self-hosts it. */
  serviceId: string;
  /** The operator's URL for an instance elsewhere. */
  envVar: string;
  /** The public instance used when neither is set; null when there is none. */
  publicDefault: string | null;
  /** An API route an operator's URL may name, which is not part of the instance's base URL. */
  routeSuffix?: string;
}

const PLATFORM_ENDPOINTS: Readonly<Record<HealthCheckEndpointId, PlatformEndpointDefinition>> = {
  overpass: {
    serviceId: "overpass",
    envVar: "OVERPASS_URL",
    publicDefault: "https://overpass-api.de",
    routeSuffix: "/api/interpreter",
  },
};

export interface ResolvedPlatformEndpoint {
  /** The instance's base URL, without a trailing slash or API route. */
  url: string;
  source: "service" | "operator" | "default";
}

/** The built-in service that self-hosts `id`. */
export function platformEndpointServiceId(id: HealthCheckEndpointId): string {
  return PLATFORM_ENDPOINTS[id].serviceId;
}

/**
 * The instance requests for `id` go to: the self-hosted service when it is
 * enabled (`selfHostedUrl`), then the operator's URL, then the public default.
 * The platform's clients and health checks both resolve through this, so a
 * health check always probes the instance actually queried.
 */
export function resolvePlatformEndpoint(
  id: HealthCheckEndpointId,
  selfHostedUrl: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedPlatformEndpoint | null {
  const definition = PLATFORM_ENDPOINTS[id];
  const base = (url: string) => {
    let trimmed = url.trim();
    // A loop, not /\/+$/: that regex is quadratic on a long run of slashes.
    while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
    const suffix = definition.routeSuffix;
    return suffix && trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
  };
  if (selfHostedUrl?.trim()) return { url: base(selfHostedUrl), source: "service" };
  const operatorUrl = env[definition.envVar]?.trim();
  if (operatorUrl) return { url: base(operatorUrl), source: "operator" };
  return definition.publicDefault ? { url: definition.publicDefault, source: "default" } : null;
}
