import { readBoundedJsonResponse } from "../utils/fetchJson";
import {
  DEFAULT_NDJSON_STREAM_LIMITS,
  readBoundedNdjsonStream,
  type StreamReadLimits,
} from "./bounded-ndjson";
import type { DatasetMetadata } from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_JSON_MAX_BYTES = 8 * 1024 * 1024;

export interface DataManagerClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Shared secret that the data-manager requires on every non-health request.
   * Defaults to `process.env.DATA_MANAGER_AUTH_TOKEN`. Leaving this unset when
   * the server has a token configured will produce 401 responses on every
   * mutation call.
   */
  authToken?: string;
  /** Cancels every request and stream made by this client. */
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxJsonBytes?: number;
  maxStreamBytes?: number;
}

export type TransitSourceLifecycle =
  | "active"
  | "add-pending"
  | "update-pending"
  | "removal-pending"
  | "disabled"
  | "failed"
  | "stale";

export interface TransitSourceRow {
  id: string;
  region: string;
  name: string;
  format: "gtfs" | "netex";
  origin: "catalog" | "operator";
  originUrl?: string;
  license: Record<string, unknown>;
  requested: boolean;
  active: boolean;
  activeEpoch?: string;
  artifact?: { path: string; sha256: string; sizeBytes: number; retrievedAt: string };
  lastFetchedAt?: string;
  lastImportedAt?: string;
  validationStatus?: string;
  validationMessage?: string;
  lifecycle: TransitSourceLifecycle;
}

export interface TransitSourceMutationResult {
  jobId: string;
  sourceId: string;
  status: "started";
}

export interface SearchIndexStatus {
  region: string;
  sourcePath: string | null;
  sourceFingerprint: string | null;
  currentFingerprint: string | null;
  epoch: string | null;
  status: "building" | "ready" | "failed";
  placeCount: number;
  termCount: number;
  startedAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  lastError: string | null;
  stale: boolean;
  building: boolean;
}

export interface SearchIndexBuildResult {
  ok: boolean;
  region?: string;
  epoch?: string;
  placeCount?: number;
  termCount?: number;
  message?: string;
}

export class DataManagerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DataManagerHttpError";
  }
}

/** Operator-extended list of hostnames allowed to reach the data-manager over plain HTTP. */
export const DATA_MANAGER_PLAINTEXT_HOSTS_ENV = "DATA_MANAGER_PLAINTEXT_HOSTS";

function configuredPlaintextHosts(): string[] {
  const raw = typeof process !== "undefined" ? process.env?.[DATA_MANAGER_PLAINTEXT_HOSTS_ENV] : "";
  return (raw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Accept TLS endpoints, or the deliberately narrow plaintext set used by the
 * local process and the Compose service network. Credentials, path prefixes,
 * queries and fragments are forbidden because callers append trusted routes.
 * Deployments that legitimately reach the data-manager over plain HTTP on
 * another host (a LAN address, a differently named Compose service) list those
 * hostnames in `DATA_MANAGER_PLAINTEXT_HOSTS` or pass `allowPlaintextHosts`.
 */
export function validateDataManagerBaseUrl(
  value: string,
  options: { allowPlaintextHosts?: readonly string[] } = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid data-manager base URL");
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Invalid data-manager base URL: credentials and URL suffixes are not allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  const localPlaintextHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "::1",
    "data-manager",
    ...(options.allowPlaintextHosts ?? configuredPlaintextHosts()).map((host) =>
      host.toLowerCase(),
    ),
  ]);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && localPlaintextHosts.has(hostname))
  ) {
    throw new Error(
      `Data-manager destination must use HTTPS or an approved loopback/Compose hostname (extend with ${DATA_MANAGER_PLAINTEXT_HOSTS_ENV})`,
    );
  }
  return parsed.origin;
}

export class DataManagerClient {
  private baseUrl: string;
  private fetchImpl: typeof globalThis.fetch;
  private authToken: string | undefined;
  private requestSignal: AbortSignal | undefined;
  private requestTimeoutMs: number;
  private streamIdleTimeoutMs: number;
  private maxJsonBytes: number;
  private maxStreamBytes: number;

  constructor(opts: DataManagerClientOptions) {
    this.baseUrl = validateDataManagerBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.requestSignal = opts.signal;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.streamIdleTimeoutMs =
      opts.streamIdleTimeoutMs ?? DEFAULT_NDJSON_STREAM_LIMITS.idleTimeoutMs;
    this.maxJsonBytes = opts.maxJsonBytes ?? DEFAULT_JSON_MAX_BYTES;
    this.maxStreamBytes = opts.maxStreamBytes ?? DEFAULT_NDJSON_STREAM_LIMITS.maxBytes;
    this.authToken =
      opts.authToken ??
      (typeof process !== "undefined"
        ? process.env?.DATA_MANAGER_AUTH_TOKEN?.trim() || undefined
        : undefined);
  }

  /** Merge caller-supplied init with the Authorization bearer header. */
  private authed(init: RequestInit = {}): RequestInit {
    if (!this.authToken) return init;
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.authToken}`);
    }
    return { ...init, headers };
  }

  private async request(
    input: string,
    init: RequestInit = {},
    streaming = false,
  ): Promise<Response> {
    const timeoutController = streaming ? new AbortController() : undefined;
    const timeoutSignal = timeoutController?.signal ?? AbortSignal.timeout(this.requestTimeoutMs);
    const signals = [timeoutSignal, this.requestSignal, init.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined && signal !== null,
    );
    const timeoutId = timeoutController
      ? setTimeout(
          () => timeoutController.abort(new Error("data-manager response timed out")),
          this.requestTimeoutMs,
        )
      : undefined;
    try {
      return await this.fetchImpl(input, {
        ...init,
        redirect: "error",
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private readJson<T>(response: Response, label: string): Promise<T> {
    return readBoundedJsonResponse<T>(response, { maxBytes: this.maxJsonBytes, label });
  }

  private streamLimits(): StreamReadLimits {
    return { maxBytes: this.maxStreamBytes, idleTimeoutMs: this.streamIdleTimeoutMs };
  }

  statusUrl(): string {
    return `${this.baseUrl}/status`;
  }

  async status(): Promise<{ ok: boolean; uptime: number; dataDir: string }> {
    // /status intentionally skips auth so container health probes work.
    const res = await this.request(this.statusUrl());
    if (!res.ok) throw new Error(`status failed: HTTP ${res.status}`);
    return this.readJson(res, "data-manager status response");
  }

  async datasets(): Promise<DatasetMetadata[]> {
    const res = await this.request(`${this.baseUrl}/datasets`, this.authed());
    if (!res.ok) throw new Error(`datasets failed: HTTP ${res.status}`);
    const body = await this.readJson<{ datasets: DatasetMetadata[] }>(res, "datasets response");
    return body.datasets;
  }

  async reloadDatasets(): Promise<{ ok: boolean; datasets: number }> {
    const res = await this.request(
      `${this.baseUrl}/datasets/reload`,
      this.authed({ method: "POST" }),
    );
    if (!res.ok) throw new Error(`datasets/reload failed: HTTP ${res.status}`);
    const body = await this.readJson<Partial<{ ok: boolean; datasets: number }>>(
      res,
      "datasets/reload response",
    );
    return {
      ok: body.ok ?? true,
      datasets: body.datasets ?? 0,
    };
  }

  async downloadOsm(
    region: string,
    opts: { onProgress?: (bytesDownloaded: number, totalBytes?: number) => void } = {},
  ): Promise<{ ok: boolean; path: string; sizeBytes: number }> {
    const res = await this.request(
      `${this.baseUrl}/download/osm`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
      true,
    );
    return readProgressStream(res, "download/osm", opts.onProgress, {}, this.streamLimits());
  }

  async convertOverpass(
    opts: {
      region?: string;
      onProgress?: (bytesConverted: number, totalBytes?: number) => void;
    } = {},
  ): Promise<{ ok: boolean; path: string; sizeBytes: number }> {
    const body = opts.region ? { region: opts.region } : {};
    const res = await this.request(
      `${this.baseUrl}/convert/overpass`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      true,
    );
    return readProgressStream(
      res,
      "convert/overpass",
      opts.onProgress,
      {
        pathField: "targetBz2",
      },
      this.streamLimits(),
    );
  }

  async syncTransit(
    input: { countries?: string[]; idempotencyKey?: string; triggeredBy?: string } = {},
  ): Promise<{ jobId: string; status: "started" }> {
    const res = await this.request(
      `${this.baseUrl}/transit/sync`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    const parsed = await this.readJson<{
      jobId?: string;
      status?: "started";
      error?: string;
      reason?: string;
    }>(res, "transit/sync response");
    if (!res.ok || !parsed.jobId) {
      throw new Error(parsed.error ?? parsed.reason ?? `transit/sync failed: HTTP ${res.status}`);
    }
    return { jobId: parsed.jobId, status: parsed.status ?? "started" };
  }

  async transitSources(
    query: {
      search?: string;
      lifecycle?: TransitSourceLifecycle;
      origin?: "catalog" | "operator";
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ sources: TransitSourceRow[]; total: number; limit: number; offset: number }> {
    const params = new URLSearchParams();
    if (query.search) params.set("search", query.search);
    if (query.lifecycle) params.set("lifecycle", query.lifecycle);
    if (query.origin) params.set("origin", query.origin);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const suffix = params.size > 0 ? `?${params}` : "";
    const res = await this.request(`${this.baseUrl}/transit/sources${suffix}`, this.authed());
    if (!res.ok) throw new Error(`transit/sources failed: HTTP ${res.status}`);
    return this.readJson<{
      sources: TransitSourceRow[];
      total: number;
      limit: number;
      offset: number;
    }>(res, "transit/sources response");
  }

  async addTransitSource(input: {
    region: string;
    name: string;
    url: string;
    license: {
      spdxIdentifier?: string;
      url?: string;
      attribution: string;
      publisher?: string;
      publisherUrl?: string;
    };
    idempotencyKey?: string;
  }): Promise<TransitSourceMutationResult> {
    return this.transitSourceMutation("/transit/sources", "POST", input);
  }

  async removeTransitSource(
    sourceId: string,
    idempotencyKey?: string,
  ): Promise<TransitSourceMutationResult> {
    return this.transitSourceMutation(
      `/transit/sources/${encodeURIComponent(sourceId)}`,
      "DELETE",
      { idempotencyKey },
    );
  }

  async enableTransitSource(
    sourceId: string,
    idempotencyKey?: string,
  ): Promise<TransitSourceMutationResult> {
    return this.transitSourceMutation(
      `/transit/sources/${encodeURIComponent(sourceId)}/enable`,
      "POST",
      { idempotencyKey },
    );
  }

  private async transitSourceMutation(
    path: string,
    method: "POST" | "DELETE",
    body: unknown,
  ): Promise<TransitSourceMutationResult> {
    const res = await this.request(
      `${this.baseUrl}${path}`,
      this.authed({
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const parsed = await this.readJson<
      TransitSourceMutationResult & {
        error?: string;
        reason?: string;
      }
    >(res, `${method} ${path} response`);
    if (!res.ok) {
      throw new Error(
        parsed.error ?? parsed.reason ?? `${method} ${path} failed: HTTP ${res.status}`,
      );
    }
    return parsed;
  }

  async downloadFonts(): Promise<{ ok: boolean }> {
    const res = await this.request(
      `${this.baseUrl}/download/fonts`,
      this.authed({ method: "POST" }),
    );
    if (!res.ok) throw new Error(`download/fonts failed: HTTP ${res.status}`);
    return this.readJson(res, "download/fonts response");
  }

  async link(
    plan: Array<{
      source: string;
      target: string;
      consumerService: string;
      dataType: string;
      targetFilename?: string;
    }>,
    opts: { prune?: boolean } = {},
  ): Promise<{ linked: number; skipped: number; pruned: number }> {
    const res = await this.request(
      `${this.baseUrl}/link`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, prune: opts.prune }),
      }),
    );
    if (!res.ok) throw new Error(`link failed: HTTP ${res.status}`);
    const parsed = await this.readJson<
      Partial<{
        linked: number;
        skipped: number;
        pruned: number;
      }>
    >(res, "link response");
    return {
      linked: parsed.linked ?? 0,
      skipped: parsed.skipped ?? 0,
      pruned: parsed.pruned ?? 0,
    };
  }

  async pullOverture(
    region: string,
    opts: { onProgress?: (msg: string) => void } = {},
  ): Promise<{ ok: boolean; message?: string }> {
    const res = await this.request(
      `${this.baseUrl}/overture/pull`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
      true,
    );
    return readNdjsonOperationStream(res, "overture/pull", opts.onProgress, this.streamLimits());
  }

  async overtureStatus(): Promise<Record<string, unknown>> {
    const res = await this.request(`${this.baseUrl}/overture/status`, this.authed());
    if (!res.ok) throw new Error(`overture/status failed: HTTP ${res.status}`);
    return this.readJson(res, "overture/status response");
  }

  async syncOverture(
    region: string,
    opts: { onProgress?: (msg: string) => void } = {},
  ): Promise<{
    ok: boolean;
    message?: string;
    release?: string;
    linked?: number;
    conflation?: string;
    conflationError?: string;
  }> {
    const res = await this.request(
      `${this.baseUrl}/overture/sync`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
      true,
    );
    return readNdjsonOperationStream(
      res,
      "overture/sync",
      opts.onProgress,
      this.streamLimits(),
    ) as Promise<{
      ok: boolean;
      message?: string;
      release?: string;
      linked?: number;
      conflation?: string;
      conflationError?: string;
    }>;
  }

  async ingestOverture(
    region: string,
    opts: { onProgress?: (msg: string) => void } = {},
  ): Promise<{ ok: boolean; message?: string }> {
    const res = await this.request(
      `${this.baseUrl}/overture/ingest`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
      true,
    );
    return readNdjsonOperationStream(res, "overture/ingest", opts.onProgress, this.streamLimits());
  }

  async extractOverture(
    region: string,
    opts: { onProgress?: (msg: string) => void } = {},
  ): Promise<{ ok: boolean; message?: string }> {
    const res = await this.request(
      `${this.baseUrl}/overture/extract`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
      true,
    );
    return readNdjsonOperationStream(res, "overture/extract", opts.onProgress, this.streamLimits());
  }

  async conflateOverture(
    region: string,
    opts: { restart?: boolean; onProgress?: (msg: string) => void } = {},
  ): Promise<{
    ok: boolean;
    linked?: number;
    extracted?: number;
    candidates?: number;
    status?: string;
    message?: string;
  }> {
    const res = await this.request(
      `${this.baseUrl}/overture/conflate`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region, restart: opts.restart === true }),
      }),
      true,
    );
    return readNdjsonOperationStream(
      res,
      "overture/conflate",
      opts.onProgress,
      this.streamLimits(),
    ) as Promise<{
      ok: boolean;
      linked?: number;
      extracted?: number;
      candidates?: number;
      status?: string;
      message?: string;
    }>;
  }

  // POI ingest pipeline — wraps the /poi-ingest/* routes. Methods are typed
  // loosely (Record<string, unknown>) because the server-side response shape is
  // expanding (drift guard, etc.) and CLI callers don't need strict types.

  async poiIngestState(): Promise<Record<string, unknown>> {
    const res = await this.request(`${this.baseUrl}/poi-ingest/state`, this.authed());
    if (!res.ok) throw new Error(`poi-ingest/state failed: HTTP ${res.status}`);
    return this.readJson(res, "poi-ingest/state response");
  }

  async poiIngestSources(filter?: {
    domain?: string;
    status?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (filter?.domain) params.set("domain", filter.domain);
    if (filter?.status) params.set("status", filter.status);
    const qs = params.toString();
    const res = await this.request(
      `${this.baseUrl}/poi-ingest/sources${qs ? `?${qs}` : ""}`,
      this.authed(),
    );
    if (!res.ok) throw new Error(`poi-ingest/sources failed: HTTP ${res.status}`);
    const body = await this.readJson<{ sources?: Array<Record<string, unknown>> }>(
      res,
      "poi-ingest/sources response",
    );
    return body.sources ?? [];
  }

  async poiIngestSource(id: string): Promise<Record<string, unknown>> {
    const res = await this.request(
      `${this.baseUrl}/poi-ingest/sources/${encodeURIComponent(id)}`,
      this.authed(),
    );
    if (res.status === 404) throw new Error(`poi-ingest source "${id}" not found`);
    if (!res.ok) throw new Error(`poi-ingest/sources/${id} failed: HTTP ${res.status}`);
    return this.readJson(res, `poi-ingest/sources/${id} response`);
  }

  async poiIngestSync(
    id: string,
    opts: { liveOnly?: boolean; idempotencyKey?: string; triggeredBy?: string } = {},
  ): Promise<Record<string, unknown>> {
    const route = opts.liveOnly ? "sync-live" : "sync";
    const res = await this.request(
      `${this.baseUrl}/poi-ingest/sources/${encodeURIComponent(id)}/${route}`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: opts.idempotencyKey,
          triggeredBy: opts.triggeredBy ?? "cli",
        }),
      }),
    );
    let body: Record<string, unknown> = {};
    try {
      body = await this.readJson<Record<string, unknown>>(res, "poi-ingest sync response");
    } catch (error) {
      // Some older error responses have an empty/non-JSON body. Preserve their
      // status-specific diagnostics, but never hide a malformed or oversized
      // successful response.
      if (res.ok) throw error;
    }
    if (res.status === 404) throw new Error(`poi-ingest source "${id}" not found`);
    if (res.status === 409) {
      throw new Error(
        `poi-ingest sync conflict: ${(body.reason as string) ?? "in-flight"} (existing job ${(body.existingJobId as string) ?? "?"})`,
      );
    }
    if (res.status === 400) {
      throw new Error(`poi-ingest sync rejected: ${(body.error as string) ?? "bad-request"}`);
    }
    if (!res.ok) throw new Error(`poi-ingest sync failed: HTTP ${res.status}`);
    return body;
  }

  async buildSearchIndex(
    region: string,
    onProgress?: (message: string) => void,
  ): Promise<SearchIndexBuildResult> {
    const res = await this.request(
      `${this.baseUrl}/search-index/build`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
      true,
    );
    return readNdjsonOperationStream(
      res,
      "search-index/build",
      onProgress,
      this.streamLimits(),
    ) as Promise<SearchIndexBuildResult>;
  }

  async searchIndexStatus(): Promise<SearchIndexStatus> {
    const res = await this.request(`${this.baseUrl}/search-index/status`, this.authed());
    if (!res.ok) {
      throw new DataManagerHttpError(`search-index/status failed: HTTP ${res.status}`, res.status);
    }
    return this.readJson(res, "search-index/status response");
  }
}

/**
 * Parse an NDJSON progress stream from Overture endpoints. Each line is:
 *
 *   `{event: "progress", message}`
 *   `{event: "done",     ok, ...result}`
 *   `{event: "error",    message}`
 */
async function readNdjsonOperationStream(
  res: { ok: boolean; body: ReadableStream<Uint8Array> | null; status?: number },
  label: string,
  onProgress?: (msg: string) => void,
  limits: StreamReadLimits = DEFAULT_NDJSON_STREAM_LIMITS,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  return readBoundedNdjsonStream(
    res,
    label,
    (message) => {
      if (message.event === "progress") {
        onProgress?.(String(message.message ?? ""));
      } else if (message.event === "done") {
        return { ok: Boolean(message.ok), ...message };
      }
      return undefined;
    },
    limits,
  );
}

/**
 * Parse an NDJSON progress stream emitted by the data-manager's long-running
 * endpoints (`/download/osm`, `/convert/overpass`, …). Each line is a JSON
 * object:
 *
 *   `{event: "progress", bytes, totalBytes?}`
 *   `{event: "done",     ok, path | targetBz2, sizeBytes, ...}`
 *   `{event: "error",    message}`
 *
 * The `path` field's name varies across endpoints; pass `pathField` to map
 * whichever key the server uses onto the return value's `path` property.
 */
async function readProgressStream(
  res: { ok: boolean; body: ReadableStream<Uint8Array> | null; status?: number },
  label: string,
  onProgress?: (bytes: number, totalBytes?: number) => void,
  opts: { pathField?: string } = {},
  limits: StreamReadLimits = DEFAULT_NDJSON_STREAM_LIMITS,
): Promise<{ ok: boolean; path: string; sizeBytes: number }> {
  const pathField = opts.pathField ?? "path";
  return readBoundedNdjsonStream(
    res,
    label,
    (message) => {
      if (message.event === "progress") {
        onProgress?.(
          Number(message.bytes) || 0,
          typeof message.totalBytes === "number" ? message.totalBytes : undefined,
        );
      } else if (message.event === "done") {
        return {
          ok: Boolean(message.ok),
          path: String(message[pathField] ?? message.path ?? ""),
          sizeBytes: Number(message.sizeBytes) || 0,
        };
      }
      return undefined;
    },
    limits,
  );
}
