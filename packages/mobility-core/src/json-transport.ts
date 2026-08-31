export interface MobilityHttpRequestOptions {
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  allowPrivateHosts?: string[];
  allowedRedirectHosts?: string[];
}

export interface MobilityHttpTransport {
  userAgent: string;
  fetchJson<T>(url: string, options?: MobilityHttpRequestOptions): Promise<T>;
  fetchText(url: string, options?: MobilityHttpRequestOptions): Promise<string>;
  hostMatchesAllowlist(hostname: string, pattern: string): boolean;
  privateFeedHostAllowlist(): string[];
}
