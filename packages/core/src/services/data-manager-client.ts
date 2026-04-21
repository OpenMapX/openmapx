import type { DatasetMetadata } from "./types";

export interface DataManagerClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export interface GtfsDownloadFailure {
  id: string;
  country: string;
  url: string;
  message: string;
}

export interface GtfsDownloadResult {
  count: number;
  usedTransitousPipeline: boolean;
  requestedCount: number;
  selectedCount: number;
  skippedCount: number;
  failedCount: number;
  partialSuccess: boolean;
  failures: GtfsDownloadFailure[];
}

export class DataManagerClient {
  private baseUrl: string;
  private fetchImpl: typeof globalThis.fetch;

  constructor(opts: DataManagerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  statusUrl(): string {
    return `${this.baseUrl}/status`;
  }

  async status(): Promise<{ ok: boolean; uptime: number; dataDir: string }> {
    const res = await this.fetchImpl(this.statusUrl());
    if (!res.ok) throw new Error(`status failed: HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean; uptime: number; dataDir: string };
  }

  async datasets(): Promise<DatasetMetadata[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/datasets`);
    if (!res.ok) throw new Error(`datasets failed: HTTP ${res.status}`);
    const body = (await res.json()) as { datasets: DatasetMetadata[] };
    return body.datasets;
  }

  async reloadDatasets(): Promise<{ ok: boolean; datasets: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/datasets/reload`, { method: "POST" });
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
    const res = await this.fetchImpl(`${this.baseUrl}/download/osm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region }),
    });
    return readProgressStream(res, "download/osm", opts.onProgress);
  }

  async convertOverpass(
    opts: {
      region?: string;
      onProgress?: (bytesConverted: number, totalBytes?: number) => void;
    } = {},
  ): Promise<{ ok: boolean; path: string; sizeBytes: number }> {
    const body = opts.region ? { region: opts.region } : {};
    const res = await this.fetchImpl(`${this.baseUrl}/convert/overpass`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return readProgressStream(res, "convert/overpass", opts.onProgress, {
      pathField: "targetBz2",
    });
  }

  async downloadGtfs(
    opts:
      | {
          feeds: Array<{ id: string; country: string; url: string }>;
          countries?: string[];
        }
      | { source: "transitous"; countries?: string[] },
  ): Promise<GtfsDownloadResult> {
    const body =
      "feeds" in opts
        ? { feeds: opts.feeds, countries: opts.countries ?? [] }
        : { source: opts.source, countries: opts.countries ?? [] };
    const res = await this.fetchImpl(`${this.baseUrl}/download/gtfs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`download/gtfs failed: HTTP ${res.status}`);
    const parsed = (await res.json()) as Partial<GtfsDownloadResult> & { error?: string };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      throw new Error(parsed.error.trim());
    }
    return {
      count: parsed.count ?? 0,
      usedTransitousPipeline: parsed.usedTransitousPipeline ?? false,
      requestedCount: parsed.requestedCount ?? 0,
      selectedCount: parsed.selectedCount ?? 0,
      skippedCount: parsed.skippedCount ?? 0,
      failedCount: parsed.failedCount ?? 0,
      partialSuccess: parsed.partialSuccess ?? false,
      failures: parsed.failures ?? [],
    };
  }

  async downloadStyle(): Promise<{ ok: boolean }> {
    const res = await this.fetchImpl(`${this.baseUrl}/download/style`, { method: "POST" });
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
    const res = await this.fetchImpl(`${this.baseUrl}/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, prune: opts.prune }),
    });
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
