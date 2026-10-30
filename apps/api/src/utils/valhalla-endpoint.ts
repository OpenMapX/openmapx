import { resolvePlatformEndpoint } from "@openmapx/core";
import { serviceUrl } from "../services/service-registry.js";

/**
 * Resolved Valhalla base URL, as integrations and health checks resolve it:
 * the self-hosted service, then VALHALLA_URL, then Stadia Maps. Stadia hosts a
 * Valhalla-compatible API on the same paths and needs VALHALLA_API_KEY (free
 * non-commercial tier); a self-hosted Valhalla works key-less.
 */
export function valhallaBaseUrl(): string {
  const endpoint = resolvePlatformEndpoint("valhalla", { selfHostedUrl: serviceUrl("valhalla") });
  if (!endpoint) throw new Error("Valhalla has a public default endpoint");
  return endpoint.url;
}

/**
 * Full Valhalla endpoint URL for a path like "/isochrone". Appends
 * `api_key` when VALHALLA_API_KEY is set (required by Stadia; ignored by
 * key-less self-hosted instances).
 */
export function valhallaEndpoint(path: string): string {
  const url = `${valhallaBaseUrl()}${path}`;
  const key = process.env.VALHALLA_API_KEY;
  if (!key) return url;
  return `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}`;
}
