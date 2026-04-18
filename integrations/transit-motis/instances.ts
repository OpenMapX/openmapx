import { type Client, createClient } from "@hey-api/client-fetch";
import { USER_AGENT_TRANSIT } from "@openmapx/core";

const TIMEOUT_MS = 8_000;

const USER_AGENT = process.env.TRANSITOUS_USER_AGENT ?? USER_AGENT_TRANSIT;

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

export const transitousInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: process.env.TRANSITOUS_URL ?? "https://api.transitous.org",
    headers: { "User-Agent": USER_AGENT },
  });
  withTimeout(client);
  return { client, prefix: "mo:", provider: "mo" };
})();

export const motisLocalInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: process.env.MOTIS_URL ?? "http://localhost:8081",
  });
  withTimeout(client);
  return { client, prefix: "ms:", provider: "ms" };
})();

/** Update the local MOTIS base URL (called from setup() when service registry resolves it). */
export function setMotisLocalUrl(url: string): void {
  motisLocalInstance.client.setConfig({ baseUrl: url });
}
