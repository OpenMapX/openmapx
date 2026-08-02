import { USER_AGENT } from "./userAgent";

/** Default HTTP timeout for upstream JSON APIs. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface FetchJsonOptions {
  /** Abort the request after this many milliseconds. Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Extra request headers, merged on top of the `User-Agent`. */
  headers?: Record<string, string>;
  /** Upstream name baked into thrown error messages, e.g. `"Open-Meteo HTTP 503"`. */
  label?: string;
  /**
   * Build the message thrown on a non-2xx response. Overrides `label`. Lets a
   * caller preserve a bespoke diagnostic string (status text, URL, path, …).
   * `body` is truncated to keep upstream diagnostics useful without allowing a
   * large or unexpected response to flood logs.
   */
  errorMessage?: (info: {
    status: number;
    statusText: string;
    url: string;
    body?: string;
  }) => string;
  /**
   * `User-Agent` to send. Defaults to the shared {@link USER_AGENT}. Pass `null`
   * to omit the header entirely (preserves the behaviour of callers that never
   * set one).
   */
  userAgent?: string | null;
  /** When `true`, return `null` on any failure (timeout, network, non-2xx, parse) instead of throwing. */
  nullOnError?: boolean;
  /** Extra `fetch` init (e.g. `method`, `body`). `signal` and `headers` are managed here. */
  init?: Omit<RequestInit, "signal" | "headers">;
}

async function request<T>(url: string, options: FetchJsonOptions): Promise<T> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    headers,
    label = "fetch",
    userAgent = USER_AGENT,
    errorMessage,
    init,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...(userAgent ? { "User-Agent": userAgent } : {}), ...headers },
    });
    if (!res.ok) {
      const body =
        typeof res.text === "function" ? (await res.text()).trim().slice(0, 1_024) : undefined;
      throw new Error(
        errorMessage
          ? errorMessage({ status: res.status, statusText: res.statusText, url, body })
          : `${label} HTTP ${res.status}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch JSON with a `User-Agent` header and an `AbortController`-based timeout.
 *
 * Throws on a non-2xx response (with `label` in the message) or on timeout /
 * network / parse errors — unless `nullOnError` is set, in which case it
 * resolves to `null` on any failure.
 */
export function fetchJson<T>(
  url: string,
  options: FetchJsonOptions & { nullOnError: true },
): Promise<T | null>;
export function fetchJson<T>(url: string, options?: FetchJsonOptions): Promise<T>;
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T | null> {
  if (options.nullOnError) {
    try {
      return await request<T>(url, options);
    } catch {
      return null;
    }
  }
  return request<T>(url, options);
}
