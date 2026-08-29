import { type Client, createClient } from "@hey-api/client-fetch";
import { USER_AGENT_TRANSIT } from "@openmapx/core";

const TIMEOUT_MS = 8_000;
const REACHABILITY_TIMEOUT_MS = 30_000;

// MOTIS declares array query params (transitModes, pre/postTransitModes, …) as
// `explode: false` — comma-joined in a single param (`transitModes=TRAM,BUS`).
// The MOTIS server honours only the FIRST occurrence of a repeated param, so the
// client-fetch default (`explode: true` → `transitModes=TRAM&transitModes=BUS`)
// silently collapses every multi-mode allow-list to its first entry. That makes
// the Deutschlandticket filter (whose list starts with the deprecated, unmatched
// REGIONAL_FAST_RAIL) return zero itineraries. Serialise arrays comma-joined to
// match the spec.
const QUERY_SERIALIZER = { array: { explode: false, style: "form" } } as const;

export interface MotisInstance {
  client: Client;
  prefix: string;
  provider: string;
}

function withTimeout(client: Client, timeoutMs = TIMEOUT_MS): void {
  client.interceptors.request.use((request) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    return new Request(request, { signal });
  });
}

// Constructed with hardcoded defaults; setup(ctx) updates the `baseUrl` and
// User-Agent header from the resolved integration config cascade before the
// clients are used.
export const transitousInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: "https://api.transitous.org",
    headers: { "User-Agent": USER_AGENT_TRANSIT },
    querySerializer: QUERY_SERIALIZER,
  });
  withTimeout(client);
  return { client, prefix: "mo:", provider: "mo" };
})();

export const motisLocalInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: "http://localhost:8081",
    querySerializer: QUERY_SERIALIZER,
  });
  withTimeout(client);
  return { client, prefix: "ms:", provider: "ms" };
})();

/** Dedicated longer-lived client for bounded, sequential exact reachability batches. */
export const motisLocalReachabilityInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: "http://localhost:8081",
    querySerializer: QUERY_SERIALIZER,
  });
  withTimeout(client, REACHABILITY_TIMEOUT_MS);
  return { client, prefix: "ms:", provider: "ms" };
})();

/** Update the local MOTIS base URL (called from setup() when service registry resolves it). */
export function setMotisLocalUrl(url: string): void {
  motisLocalInstance.client.setConfig({ baseUrl: url });
  motisLocalReachabilityInstance.client.setConfig({ baseUrl: url });
}

/** Update the Transitous cloud base URL + optional User-Agent override. */
export function configureTransitous(opts: { url?: string; userAgent?: string }): void {
  const cfg: { baseUrl?: string; headers?: Record<string, string> } = {};
  if (opts.url && opts.url.length > 0) cfg.baseUrl = opts.url;
  cfg.headers = { "User-Agent": opts.userAgent?.trim() || USER_AGENT_TRANSIT };
  transitousInstance.client.setConfig(cfg);
}
