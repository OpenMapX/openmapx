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
    // Responses without a readable stream still use a length-capped read.
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

/** Per-request controls available to every method. */
export interface ApiRequestOptions {
  signal?: AbortSignal;
  /** Abort after this many milliseconds. Omitted means no client-side deadline. */
  timeoutMs?: number;
}

/**
 * Raised when a request is cut short rather than answered. Kept separate from
 * `ApiClientError` because a timeout is a local decision, not a server reply,
 * and callers retry the two very differently.
 */
export class ApiRequestAbortedError extends Error {
  readonly code: "timeout" | "aborted";

  constructor(code: "timeout" | "aborted") {
    super(code === "timeout" ? "API request timed out" : "API request was aborted");
    this.name = "ApiRequestAbortedError";
    this.code = code;
  }
}

export function isApiRequestAbortedError(value: unknown): value is ApiRequestAbortedError {
  return value instanceof ApiRequestAbortedError;
}

/**
 * The API client.
 *
 * A client constructed with an explicit config uses *only* that config. This is
 * what lets the mobile background task talk to the compiled API origin with
 * `credentials: "omit"` while the browser singleton keeps sending cookies —
 * without either being able to reconfigure the other. Calls interleave freely
 * because nothing is read from module scope at request time.
 */
export class ApiClient {
  constructor(private readonly instanceConfig?: ApiClientConfig) {}

  private config(): ApiClientConfig {
    return this.instanceConfig ?? getConfig();
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.config().baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /**
   * Runs one fetch with a merged abort signal and a guaranteed timer cleanup.
   * A pending timer would otherwise keep a background task's event loop alive
   * after the session ended.
   */
  private async send(
    url: string,
    init: RequestInit,
    options: ApiRequestOptions,
  ): Promise<Response> {
    const cfg = this.config();
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const abortFromCaller = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) throw new ApiRequestAbortedError("aborted");
      options.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
    }

    try {
      return await fetch(url, {
        ...init,
        headers: { Accept: "application/json", ...init.headers, ...cfg.headerInterceptor?.() },
        credentials: cfg.credentials ?? "omit",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiRequestAbortedError(timedOut ? "timeout" : "aborted");
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async get<T>(
    path: string,
    params?: Record<string, string>,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    const res = await this.send(this.buildUrl(path, params), {}, options);
    await assertOk(res);
    return res.json() as Promise<T>;
  }

  /**
   * Like `get`, but returns `null` when the server responds 204 No Content.
   * Useful for "found / not found" endpoints where absence is a normal answer
   * and shouldn't be modeled as an error (e.g. an enrichment endpoint that has
   * no data for inland places).
   */
  async getOptional<T>(
    path: string,
    params?: Record<string, string>,
    options: ApiRequestOptions = {},
  ): Promise<T | null> {
    const res = await this.send(this.buildUrl(path, params), {}, options);
    if (res.status === 204) return null;
    await assertOk(res);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return this.mutate<T>("POST", path, body, options);
  }

  async patch<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return this.mutate<T>("PATCH", path, body, options);
  }

  async put<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return this.mutate<T>("PUT", path, body, options);
  }

  async delete<T = void>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const res = await this.send(this.buildUrl(path), { method: "DELETE" }, options);
    await assertOk(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async mutate<T>(
    method: string,
    path: string,
    body: unknown,
    options: ApiRequestOptions,
  ): Promise<T> {
    const res = await this.send(
      this.buildUrl(path),
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      options,
    );
    await assertOk(res);
    return res.json() as Promise<T>;
  }
}

/**
 * An isolated client. Native callers use this with the compiled API origin and
 * `credentials: "omit"`, so no WebView cookie can ever ride along.
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(Object.freeze({ ...config }));
}

/** The browser singleton, still driven by `configureApiClient`. */
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
