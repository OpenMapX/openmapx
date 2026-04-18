import type { LoadedIntegration } from "./loader";
import type { IntegrationManifest } from "./manifest";

export interface HttpClientOptions {
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  cache?: { ttl: number };
}

export interface HttpClient {
  get<T = unknown>(url: string, options?: HttpClientOptions): Promise<T>;
  post<T = unknown>(url: string, body?: unknown, options?: HttpClientOptions): Promise<T>;
}

export interface CacheClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  withCache<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T>;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface DatabaseClient {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
}

export type RouteHandler = (
  req: {
    query: Record<string, string>;
    params: Record<string, string>;
    body: unknown;
    /**
     * Authenticated user id. Only populated when the route was registered
     * with `{ requireAuth: true }`; the host rejects unauthenticated callers
     * with 401 before invoking the handler, so this field is non-null inside
     * auth-required handlers.
     */
    userId?: string;
  },
  reply: {
    send: (data: unknown) => void;
    status: (code: number) => { send: (data: unknown) => void };
    header: (name: string, value: string) => void;
    type: (contentType: string) => void;
  },
) => Promise<void> | void;

export interface RouteOptions {
  /** Require a valid session; respond 401 before invoking the handler otherwise. */
  requireAuth?: boolean;
}

export interface HealthCheckResult {
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
}

export type CustomHealthCheckFn = () => Promise<HealthCheckResult>;

export interface SecretsClient {
  /** Retrieve a decrypted secret from the vault, or null if not stored. */
  get(key: string): Promise<string | null>;
}

export interface IntegrationContext {
  readonly id: string;
  readonly manifest: IntegrationManifest;
  readonly config: Record<string, unknown>;

  readonly http: HttpClient;
  readonly cache: CacheClient;
  readonly db?: DatabaseClient;
  readonly log: Logger;
  readonly secrets: SecretsClient;

  registerProvider(domain: string, provider: unknown): void;
  registerRoute(method: string, path: string, handler: RouteHandler, options?: RouteOptions): void;
  registerHealthCheck(fn: CustomHealthCheckFn): void;

  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): () => void;

  onShutdown(cleanup: () => Promise<void>): void;

  /** Query all enabled integrations registered under a domain. */
  getIntegrationsByDomain(domain: string): LoadedIntegration[];
}
