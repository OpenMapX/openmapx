import { isPublicUrl } from "@openmapx/core";

/**
 * Reasons a catalog-supplied endpoint is refused. The catalog is third-party
 * and its `options.endpoint` becomes a server-side POST target, so anything
 * that is not a public http(s) URL is dropped before the first request rather
 * than guarded at each call site.
 */
export type EndpointRejection = "not-a-string" | "not-public-http" | "insecure-with-credential";

/** True when the entry carries a credential the adapters would put on the wire. */
export function hasCredential(options: Record<string, unknown>): boolean {
  return Boolean(options.apiKey) || Boolean(options.auth);
}

/**
 * Returns null when the options are safe to use, or the reason to drop the
 * entry. Absent endpoints are allowed through unchanged: entries for protocols
 * we have no adapter for legitimately omit one, and the OTP adapter already
 * no-ops on an empty endpoint.
 */
export function registryEndpointRejection(
  options: Record<string, unknown>,
): EndpointRejection | null {
  const endpoint = options.endpoint;
  if (endpoint === undefined || endpoint === null || endpoint === "") return null;
  if (typeof endpoint !== "string") return "not-a-string";
  if (!isPublicUrl(endpoint)) return "not-public-http";
  if (hasCredential(options) && new URL(endpoint).protocol !== "https:") {
    return "insecure-with-credential";
  }
  return null;
}

/** True when the endpoint on this entry is safe for the adapters to call. */
export function registryEndpointIsUsable(options: Record<string, unknown>): boolean {
  return registryEndpointRejection(options) === null;
}
