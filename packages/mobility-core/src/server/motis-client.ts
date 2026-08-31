import { type Client, createClient } from "@hey-api/client-fetch";

const DEFAULT_TIMEOUT_MS = 8_000;
const QUERY_SERIALIZER = { array: { explode: false, style: "form" } } as const;

export interface MotisInstance {
  client: Client;
  prefix: string;
  provider: string;
}

export interface MotisInstanceOptions {
  baseUrl: string;
  prefix: string;
  provider: string;
  timeoutMs?: number;
  userAgent?: string;
}

export function createMotisInstance(options: MotisInstanceOptions): MotisInstance {
  const userAgent = options.userAgent?.trim();
  const client = createClient({
    baseUrl: options.baseUrl,
    ...(userAgent ? { headers: { "User-Agent": userAgent } } : {}),
    querySerializer: QUERY_SERIALIZER,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  client.interceptors.request.use((request) => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    return new Request(request, { signal });
  });
  return { client, prefix: options.prefix, provider: options.provider };
}
