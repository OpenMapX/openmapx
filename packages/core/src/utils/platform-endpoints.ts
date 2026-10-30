import type { PlatformEndpointId } from "@openmapx/extension-contracts";

export { ENDPOINT_URL_TEMPLATE, isPlatformEndpointId } from "@openmapx/extension-contracts";

/**
 * A platform backend that API-side clients query wherever the deployment
 * keeps it: its self-hosted service, an integration's own URL setting, an
 * operator's instance, or a public one.
 */
export interface PlatformEndpointDefinition {
  /** The built-in service that self-hosts it; null when none does. */
  serviceId: string | null;
  /** The operator's URL for an instance elsewhere. */
  envVar: string;
  /** The public instance used when nothing else is set; null when there is none. */
  publicDefault: string | null;
  /** An API route an operator's URL may name, which is not part of the instance's base URL. */
  routeSuffix?: string;
}

export const PLATFORM_ENDPOINTS: Readonly<Record<PlatformEndpointId, PlatformEndpointDefinition>> =
  {
    overpass: {
      serviceId: "overpass",
      envVar: "OVERPASS_URL",
      publicDefault: "https://overpass-api.de",
      routeSuffix: "/api/interpreter",
    },
    nominatim: {
      serviceId: "nominatim",
      envVar: "NOMINATIM_URL",
      publicDefault: "https://nominatim.openstreetmap.org",
    },
    photon: {
      serviceId: "photon",
      envVar: "PHOTON_URL",
      publicDefault: "https://photon.komoot.io",
    },
    // No public Pelias exists; without one the geocoder has no instance.
    pelias: { serviceId: "pelias", envVar: "PELIAS_URL", publicDefault: null },
    osrm: {
      serviceId: "osrm",
      envVar: "OSRM_URL",
      publicDefault: "https://router.project-osrm.org",
    },
    // Stadia Maps serves a Valhalla-compatible API and needs an API key.
    valhalla: {
      serviceId: "valhalla",
      envVar: "VALHALLA_URL",
      publicDefault: "https://api.stadiamaps.com",
    },
    // A self-hosted MOTIS. Without one, MOTIS integrations use Transitous.
    motis: { serviceId: "motis", envVar: "MOTIS_URL", publicDefault: null },
    transitous: {
      serviceId: null,
      envVar: "TRANSITOUS_URL",
      publicDefault: "https://api.transitous.org",
    },
  };

export interface ResolvedPlatformEndpoint {
  /** The instance's base URL, without a trailing slash or API route. */
  url: string;
  /**
   * Where it came from: the self-hosted service, the integration's own URL
   * setting, the operator's environment, or the public default.
   */
  source: "service" | "setting" | "operator" | "default";
}

export interface PlatformEndpointInputs {
  /** The enabled self-hosted service's URL, as the integration resolved its requirement. */
  selfHostedUrl?: string | null;
  /** The integration's own URL setting for this endpoint (`endpointConfigKeys`). */
  configuredUrl?: unknown;
}

/** The built-in service that self-hosts `id`, or null when none does. */
export function platformEndpointServiceId(id: PlatformEndpointId): string | null {
  return PLATFORM_ENDPOINTS[id].serviceId;
}

/**
 * The instance requests for `id` go to: the self-hosted service when it is
 * enabled, then the integration's own URL setting, then the operator's URL,
 * then the public default. Integration clients and health checks both resolve
 * through this, so a health check always probes the instance actually queried.
 * Null when none is set and there is no public default.
 */
export function resolvePlatformEndpoint(
  id: PlatformEndpointId,
  inputs: PlatformEndpointInputs = {},
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
  const candidates: Array<[unknown, ResolvedPlatformEndpoint["source"]]> = [
    [inputs.selfHostedUrl, "service"],
    [inputs.configuredUrl, "setting"],
    [env[definition.envVar], "operator"],
    [definition.publicDefault, "default"],
  ];
  for (const [value, source] of candidates) {
    if (typeof value === "string" && value.trim()) return { url: base(value), source };
  }
  return null;
}
