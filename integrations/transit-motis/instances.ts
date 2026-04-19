import { type Client, createClient } from "@hey-api/client-fetch";
import { USER_AGENT_TRANSIT } from "@openmapx/core";

const TIMEOUT_MS = 8_000;

export interface MotisInstance {
  client: Client;
  prefix: string;
  provider: string;
}

function withTimeout(client: Client): void {
  client.interceptors.request.use((request) => {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
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
  });
  withTimeout(client);
  return { client, prefix: "mo:", provider: "mo" };
})();

export const motisLocalInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: "http://localhost:8081",
  });
  withTimeout(client);
  return { client, prefix: "ms:", provider: "ms" };
})();

/** Update the local MOTIS base URL (called from setup() when service registry resolves it). */
export function setMotisLocalUrl(url: string): void {
  motisLocalInstance.client.setConfig({ baseUrl: url });
}

/** Update the Transitous cloud base URL + optional User-Agent override. */
export function configureTransitous(opts: { url?: string; userAgent?: string }): void {
  const cfg: { baseUrl?: string; headers?: Record<string, string> } = {};
  if (opts.url && opts.url.length > 0) cfg.baseUrl = opts.url;
  cfg.headers = { "User-Agent": opts.userAgent?.trim() || USER_AGENT_TRANSIT };
  transitousInstance.client.setConfig(cfg);
}
