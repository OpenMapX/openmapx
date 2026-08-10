/**
 * Thin fetch wrapper for the OpenMapX API gateway (`apps/api`).
 * All frontend data fetching goes through this client — never directly
 * to Pelias / OSRM / Valhalla.
 */

export interface ApiClientConfig {
  baseUrl: string;
  credentials?: RequestCredentials;
  headerInterceptor?: () => Record<string, string>;
}

let _config: ApiClientConfig | null = null;

export function configureApiClient(config: ApiClientConfig): void {
  _config = config;
}

function getConfig(): ApiClientConfig {
  if (!_config) {
    return {
      baseUrl:
        typeof window !== "undefined"
          ? (process.env.NEXT_PUBLIC_API_URL ??
            process.env.EXPO_PUBLIC_API_URL ??
            "http://localhost:3001")
          : "http://localhost:3001",
      credentials: "include",
    };
  }
  return _config;
}

/** Never read more than this from a non-2xx body; the rest is cancelled. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Upper bound for an advertised `Retry-After`, so a hostile value cannot stall the UI for days. */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * Structured transport failure. The message deliberately carries only the
 * status: upstream bodies may contain account or edit details, so the parsed
 * body lives in a non-enumerable `payload` that generic logging, spreading and
 * `JSON.stringify` cannot reach. Feature code that knows the endpoint's error
 * schema parses `payload` itself.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  /** Declared for types only; installed as a non-enumerable own property below. */
  readonly payload!: unknown;

  constructor(status: number, payload: unknown, retryAfterSeconds: number | null) {
    super(`API request failed with status ${status}`);
    this.name = "ApiClientError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    Object.defineProperty(this, "payload", {
      value: payload,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  toJSON(): {
    name: string;
    message: string;
    status: number;
    retryAfterSeconds: number | null;
  } {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

function isJsonMediaType(contentType: string | null): boolean {
  if (!contentType) return false;
  const essence = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return essence === "application/json" || essence.endsWith("+json");
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - Date.now()) / 1000);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function discardBody(res: Response): void {
  // Free the socket without materializing an unbounded upstream body.
  void res.body?.cancel().catch(() => undefined);
}

async function readBoundedBody(res: Response): Promise<string | null> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    // Mocked/legacy responses without a stream: fall back to a length-capped read.
    const text = await res.text().catch(() => null);
    if (text === null) return null;
    return text.length > MAX_ERROR_BODY_BYTES ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return null;
    }
    if (chunk.done) break;
    const value = chunk.value;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_ERROR_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Single non-2xx path for every verb. A JSON body is parsed within a byte
 * bound; anything else is discarded so it can never reach a message or log.
 */
async function toApiClientError(res: Response): Promise<ApiClientError> {
  const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
  if (!isJsonMediaType(res.headers.get("content-type"))) {
    discardBody(res);
    return new ApiClientError(res.status, null, retryAfterSeconds);
  }
  const text = await readBoundedBody(res);
  if (text === null || text.trim() === "") {
    return new ApiClientError(res.status, null, retryAfterSeconds);
  }
  try {
    return new ApiClientError(res.status, JSON.parse(text) as unknown, retryAfterSeconds);
  } catch {
    return new ApiClientError(res.status, null, retryAfterSeconds);
  }
}

async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
  throw await toApiClientError(res);
}

export class ApiClient {
  async get<T>(
    path: string,
    params?: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", ...cfg.headerInterceptor?.() },
      credentials: cfg.credentials ?? "omit",
      signal: options?.signal,
    });
    await assertOk(res);
    return res.json() as Promise<T>;
  }

  /**
   * Like `get`, but returns `null` when the server responds 204 No Content.
   * Useful for "found / not found" endpoints where absence is a normal answer
   * and shouldn't be modeled as an error (e.g. an enrichment endpoint that has
   * no data for inland places).
   */
  async getOptional<T>(path: string, params?: Record<string, string>): Promise<T | null> {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", ...cfg.headerInterceptor?.() },
      credentials: cfg.credentials ?? "omit",
    });
    if (res.status === 204) return null;
    await assertOk(res);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.mutate<T>("POST", path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.mutate<T>("PATCH", path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.mutate<T>("PUT", path, body);
  }

  async delete<T = void>(path: string): Promise<T> {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: { Accept: "application/json", ...cfg.headerInterceptor?.() },
      credentials: cfg.credentials ?? "omit",
    });
    await assertOk(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async mutate<T>(method: string, path: string, body: unknown): Promise<T> {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl);
    const res = await fetch(url.toString(), {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...cfg.headerInterceptor?.(),
      },
      credentials: cfg.credentials ?? "omit",
      body: JSON.stringify(body),
    });
    await assertOk(res);
    return res.json() as Promise<T>;
  }
}

export const apiClient = new ApiClient();

/**
 * Build the absolute URL for an API path + query params without fetching it.
 * Useful for links the browser navigates to directly (e.g. `window.open` of a
 * redirect endpoint), where a `fetch` would defeat the purpose.
 */
export function apiUrl(path: string, params?: Record<string, string>): string {
  const cfg = getConfig();
  const url = new URL(path, cfg.baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Rewrite an image URL to go through the backend image proxy.
 * This prevents leaking the user's IP address to external image hosts.
 */
export function proxyImageUrl(url: string): string {
  // Only proxy external HTTP(S) URLs
  if (!url.startsWith("http://") && !url.startsWith("https://")) return url;
  const cfg = getConfig();
  return `${cfg.baseUrl}/api/image-proxy?url=${encodeURIComponent(url)}`;
}
