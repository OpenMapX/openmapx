import { serviceUrl } from "../services/service-registry.js";
import { envString } from "./env.js";

/**
 * Default public Valhalla provider. The former FOSSGIS demo
 * (valhalla1.openstreetmap.de) is unreliable; Stadia Maps hosts a
 * Valhalla-compatible API on the same endpoint paths and is the documented
 * default. It requires VALHALLA_API_KEY (free non-commercial tier). Self-hosted
 * Valhalla works key-less via VALHALLA_URL / the `valhalla` service capability.
 */
const DEFAULT_VALHALLA_URL = "https://api.stadiamaps.com";

/** Resolved Valhalla base URL: service registry → VALHALLA_URL env → Stadia default. */
export function valhallaBaseUrl(): string {
  return serviceUrl("valhalla") ?? envString("VALHALLA_URL", DEFAULT_VALHALLA_URL);
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
