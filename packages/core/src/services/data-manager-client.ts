import type { DatasetMetadata } from "./types";

export interface DataManagerClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
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

  async downloadOsm(region: string): Promise<{ ok: boolean; path: string; sizeBytes: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/download/osm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region }),
    });
    if (!res.ok) throw new Error(`download/osm failed: HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean; path: string; sizeBytes: number };
  }

  async downloadGtfs(
    feeds: Array<{ id: string; country: string; url: string }>,
    countries: string[],
  ): Promise<number> {
    const res = await this.fetchImpl(`${this.baseUrl}/download/gtfs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feeds, countries }),
    });
    if (!res.ok) throw new Error(`download/gtfs failed: HTTP ${res.status}`);
    const body = (await res.json()) as { count: number };
    return body.count;
  }

  async link(
    plan: Array<{ source: string; target: string; consumerService: string; dataType: string }>,
  ): Promise<{ linked: number; skipped: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    if (!res.ok) throw new Error(`link failed: HTTP ${res.status}`);
    return (await res.json()) as { linked: number; skipped: number };
  }
}
