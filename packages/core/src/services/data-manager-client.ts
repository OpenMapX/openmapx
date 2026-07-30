import type { DatasetMetadata } from "./types";

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

export class DataManagerClient {
  private baseUrl: string;
  private fetchImpl: typeof globalThis.fetch;
  private authToken: string | undefined;

  constructor(opts: DataManagerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
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

  statusUrl(): string {
    return `${this.baseUrl}/status`;
  }

  async status(): Promise<{ ok: boolean; uptime: number; dataDir: string }> {
    // /status intentionally skips auth so container health probes work.
    const res = await this.fetchImpl(this.statusUrl());
    if (!res.ok) throw new Error(`status failed: HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean; uptime: number; dataDir: string };
  }

  async datasets(): Promise<DatasetMetadata[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/datasets`, this.authed());
    if (!res.ok) throw new Error(`datasets failed: HTTP ${res.status}`);
    const body = (await res.json()) as { datasets: DatasetMetadata[] };
    return body.datasets;
  }

  async reloadDatasets(): Promise<{ ok: boolean; datasets: number }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/datasets/reload`,
      this.authed({ method: "POST" }),
    );
    if (!res.ok) throw new Error(`datasets/reload failed: HTTP ${res.status}`);
    const body = (await res.json()) as Partial<{ ok: boolean; datasets: number }>;
    return {
      ok: body.ok ?? true,
      datasets: body.datasets ?? 0,
    };
  }

  async downloadOsm(
    region: string,
    opts: { onProgress?: (bytesDownloaded: number, totalBytes?: number) => void } = {},
  ): Promise<{ ok: boolean; path: string; sizeBytes: number }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/download/osm`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
    );
    return readProgressStream(res, "download/osm", opts.onProgress);
  }

  async convertOverpass(
    opts: {
      region?: string;
      onProgress?: (bytesConverted: number, totalBytes?: number) => void;
    } = {},
  ): Promise<{ ok: boolean; path: string; sizeBytes: number }> {
    const body = opts.region ? { region: opts.region } : {};
    const res = await this.fetchImpl(
      `${this.baseUrl}/convert/overpass`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return readProgressStream(res, "convert/overpass", opts.onProgress, {
      pathField: "targetBz2",
    });
  }

  async syncTransit(
    input: { countries?: string[]; idempotencyKey?: string; triggeredBy?: string } = {},
  ): Promise<{ jobId: string; status: "started" }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/transit/sync`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    const parsed = (await res.json()) as {
      jobId?: string;
      status?: "started";
      error?: string;
      reason?: string;
    };
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
    const res = await this.fetchImpl(`${this.baseUrl}/transit/sources${suffix}`, this.authed());
    if (!res.ok) throw new Error(`transit/sources failed: HTTP ${res.status}`);
    return (await res.json()) as {
      sources: TransitSourceRow[];
      total: number;
      limit: number;
      offset: number;
    };
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
    const res = await this.fetchImpl(
      `${this.baseUrl}${path}`,
      this.authed({
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const parsed = (await res.json()) as TransitSourceMutationResult & {
      error?: string;
      reason?: string;
    };
    if (!res.ok) {
      throw new Error(
        parsed.error ?? parsed.reason ?? `${method} ${path} failed: HTTP ${res.status}`,
      );
    }
    return parsed;
  }

  async downloadStyle(): Promise<{ ok: boolean }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/download/style`,
      this.authed({ method: "POST" }),
    );
    if (!res.ok) throw new Error(`download/style failed: HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean };
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
    const res = await this.fetchImpl(
      `${this.baseUrl}/link`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, prune: opts.prune }),
      }),
    );
    if (!res.ok) throw new Error(`link failed: HTTP ${res.status}`);
    const parsed = (await res.json()) as Partial<{
      linked: number;
      skipped: number;
      pruned: number;
    }>;
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
    const res = await this.fetchImpl(
      `${this.baseUrl}/overture/pull`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
    );
    return readOvertureStream(res, "overture/pull", opts.onProgress);
  }

  async overtureStatus(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/overture/status`, this.authed());
    if (!res.ok) throw new Error(`overture/status failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
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
    const res = await this.fetchImpl(
      `${this.baseUrl}/overture/sync`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
    );
    return readOvertureStream(res, "overture/sync", opts.onProgress) as Promise<{
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
    const res = await this.fetchImpl(
      `${this.baseUrl}/overture/ingest`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
    );
    return readOvertureStream(res, "overture/ingest", opts.onProgress);
  }

  async extractOverture(
    region: string,
    opts: { onProgress?: (msg: string) => void } = {},
  ): Promise<{ ok: boolean; message?: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/overture/extract`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      }),
    );
    return readOvertureStream(res, "overture/extract", opts.onProgress);
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
    const res = await this.fetchImpl(
      `${this.baseUrl}/overture/conflate`,
      this.authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region, restart: opts.restart === true }),
      }),
    );
    return readOvertureStream(res, "overture/conflate", opts.onProgress) as Promise<{
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
    const res = await this.fetchImpl(`${this.baseUrl}/poi-ingest/state`, this.authed());
    if (!res.ok) throw new Error(`poi-ingest/state failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async poiIngestSources(filter?: {
    domain?: string;
    status?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (filter?.domain) params.set("domain", filter.domain);
    if (filter?.status) params.set("status", filter.status);
    const qs = params.toString();
    const res = await this.fetchImpl(
      `${this.baseUrl}/poi-ingest/sources${qs ? `?${qs}` : ""}`,
      this.authed(),
    );
    if (!res.ok) throw new Error(`poi-ingest/sources failed: HTTP ${res.status}`);
    const body = (await res.json()) as { sources?: Array<Record<string, unknown>> };
    return body.sources ?? [];
  }

  async poiIngestSource(id: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/poi-ingest/sources/${encodeURIComponent(id)}`,
      this.authed(),
    );
    if (res.status === 404) throw new Error(`poi-ingest source "${id}" not found`);
    if (!res.ok) throw new Error(`poi-ingest/sources/${id} failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async poiIngestSync(
    id: string,
    opts: { liveOnly?: boolean; idempotencyKey?: string; triggeredBy?: string } = {},
  ): Promise<Record<string, unknown>> {
    const route = opts.liveOnly ? "sync-live" : "sync";
    const res = await this.fetchImpl(
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
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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
}

/**
 * Parse an NDJSON progress stream from Overture endpoints. Each line is:
 *
 *   `{event: "progress", message}`
 *   `{event: "done",     ok, ...result}`
 *   `{event: "error",    message}`
 */
async function readOvertureStream(
  res: { ok: boolean; body: ReadableStream<Uint8Array> | null; status?: number },
  label: string,
  onProgress?: (msg: string) => void,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status ?? "?"}`);
  if (!res.body) throw new Error(`${label}: server returned no body stream`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: { ok: boolean; [key: string]: unknown } | null = null;

  const handleLine = (line: string) => {
    if (!line) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.event === "progress") {
      onProgress?.(String(msg.message ?? ""));
    } else if (msg.event === "done") {
      final = { ok: Boolean(msg.ok), ...msg };
    } else if (msg.event === "error") {
      throw new Error(String(msg.message ?? `${label} failed`));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx < 0) break;
      handleLine(buffer.slice(0, newlineIdx).trim());
      buffer = buffer.slice(newlineIdx + 1);
    }
  }
  handleLine(buffer.trim());

  if (!final) throw new Error(`${label}: stream ended without a 'done' event`);
  return final;
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
): Promise<{ ok: boolean; path: string; sizeBytes: number }> {
  if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status ?? "?"}`);
  if (!res.body) throw new Error(`${label}: server returned no body stream`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: { ok: boolean; path: string; sizeBytes: number } | null = null;

  const pathField = opts.pathField ?? "path";

  const handleLine = (line: string) => {
    if (!line) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.event === "progress") {
      onProgress?.(
        Number(msg.bytes) || 0,
        typeof msg.totalBytes === "number" ? msg.totalBytes : undefined,
      );
    } else if (msg.event === "done") {
      final = {
        ok: Boolean(msg.ok),
        path: String(msg[pathField] ?? msg.path ?? ""),
        sizeBytes: Number(msg.sizeBytes) || 0,
      };
    } else if (msg.event === "error") {
      throw new Error(String(msg.message ?? `${label} failed`));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx < 0) break;
      handleLine(buffer.slice(0, newlineIdx).trim());
      buffer = buffer.slice(newlineIdx + 1);
    }
  }
  handleLine(buffer.trim());

  if (!final) throw new Error(`${label}: stream ended without a 'done' event`);
  return final;
}
