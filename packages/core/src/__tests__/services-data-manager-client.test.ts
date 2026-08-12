import { describe, expect, it, vi } from "vitest";
import { DataManagerClient } from "../services/data-manager-client";

describe("DataManagerClient", () => {
  it("constructs the right URL for status", () => {
    const c = new DataManagerClient({ baseUrl: "http://data-manager:4000" });
    expect(c.statusUrl()).toBe("http://data-manager:4000/status");
  });

  it("trims trailing slash from baseUrl", () => {
    const c = new DataManagerClient({ baseUrl: "http://x/" });
    expect(c.statusUrl()).toBe("http://x/status");
  });

  it("parses NDJSON progress + done events from /download/osm", async () => {
    const ndjson = [
      { event: "progress", bytes: 100, totalBytes: 1000 },
      { event: "progress", bytes: 500, totalBytes: 1000 },
      { event: "progress", bytes: 1000, totalBytes: 1000 },
      { event: "done", ok: true, path: "/data/osm/europe-germany.osm.pbf", sizeBytes: 1000 },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");

    const fakeFetch = vi.fn(async () => ({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ndjson));
          controller.close();
        },
      }),
    })) as unknown as typeof globalThis.fetch;

    const client = new DataManagerClient({ baseUrl: "http://x", fetch: fakeFetch });
    const progress: Array<[number, number | undefined]> = [];
    const result = await client.downloadOsm("europe/germany", {
      onProgress: (b, t) => progress.push([b, t]),
    });
    expect(progress).toEqual([
      [100, 1000],
      [500, 1000],
      [1000, 1000],
    ]);
    expect(result).toEqual({
      ok: true,
      path: "/data/osm/europe-germany.osm.pbf",
      sizeBytes: 1000,
    });
  });

  it("throws on an NDJSON error event", async () => {
    const ndjson = `${JSON.stringify({ event: "error", message: "upstream 404" })}\n`;
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ndjson));
          controller.close();
        },
      }),
    })) as unknown as typeof globalThis.fetch;

    const client = new DataManagerClient({ baseUrl: "http://x", fetch: fakeFetch });
    await expect(client.downloadOsm("planet")).rejects.toThrow("upstream 404");
  });

  it("posts /datasets/reload and returns the refreshed dataset count", async () => {
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return {
        ok: true,
        json: async () => ({ ok: true, datasets: 3 }),
      };
    }) as unknown as typeof globalThis.fetch;

    const client = new DataManagerClient({ baseUrl: "http://x", fetch: fakeFetch });
    const result = await client.reloadDatasets();
    expect(result).toEqual({ ok: true, datasets: 3 });
  });

  it("posts /link with prune flag and parses linked/skipped/pruned counts", async () => {
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain('"prune":true');
      return {
        ok: true,
        json: async () => ({ ok: true, linked: 7, skipped: 2, pruned: 3 }),
      };
    }) as unknown as typeof globalThis.fetch;

    const client = new DataManagerClient({ baseUrl: "http://x", fetch: fakeFetch });
    const result = await client.link(
      [
        {
          source: "data/osm",
          target: "data/valhalla/osm-pbf",
          consumerService: "valhalla",
          dataType: "osm-pbf",
        },
      ],
      { prune: true },
    );
    expect(result).toEqual({ linked: 7, skipped: 2, pruned: 3 });
  });

  it("posts an authenticated search-index build and parses NDJSON progress", async () => {
    const ndjson = [
      { event: "progress", stage: "extract", message: "Extracted 1,000 places" },
      {
        event: "done",
        ok: true,
        region: "europe/germany",
        epoch: "epoch-2",
        placeCount: 1_000,
        termCount: 2_500,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const fakeFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(ndjson, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    );

    const progress: string[] = [];
    const client = new DataManagerClient({
      baseUrl: "http://x/",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      authToken: "search-secret",
    });
    const result = await client.buildSearchIndex("europe/germany", (message) =>
      progress.push(message),
    );

    expect(progress).toEqual(["Extracted 1,000 places"]);
    expect(result).toMatchObject({
      ok: true,
      region: "europe/germany",
      epoch: "epoch-2",
      placeCount: 1_000,
      termCount: 2_500,
    });
    expect(fakeFetch).toHaveBeenCalledWith(
      "http://x/search-index/build",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
        body: JSON.stringify({ region: "europe/germany" }),
      }),
    );
    const init = fakeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer search-secret");
  });

  it("gets an authenticated typed search-index status", async () => {
    const status = {
      region: "europe/germany",
      sourcePath: "/data/osm/germany.osm.pbf",
      sourceFingerprint: "sha256:old",
      currentFingerprint: "sha256:new",
      epoch: "epoch-1",
      status: "ready",
      placeCount: 123,
      termCount: 456,
      startedAt: "2026-08-13T01:00:00.000Z",
      publishedAt: "2026-08-13T01:05:00.000Z",
      updatedAt: "2026-08-13T02:00:00.000Z",
      lastError: null,
      stale: true,
      building: false,
    } as const;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(status),
    );
    const client = new DataManagerClient({
      baseUrl: "http://x",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      authToken: "search-secret",
    });

    await expect(client.searchIndexStatus()).resolves.toEqual(status);
    const init = fakeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(fakeFetch.mock.calls[0]?.[0]).toBe("http://x/search-index/status");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer search-secret");
  });

  it("preserves an absent search index as an HTTP 404 failure", async () => {
    const fakeFetch = vi.fn(async () =>
      Response.json({ ok: false, error: "osm_search index not built" }, { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const client = new DataManagerClient({ baseUrl: "http://x", fetch: fakeFetch });

    const request = client.searchIndexStatus();
    await expect(request).rejects.toThrow("search-index/status failed: HTTP 404");
    await expect(request).rejects.toMatchObject({ status: 404 });
  });
});
