import { describe, expect, it, vi } from "vitest";
import { DataManagerClient, validateDataManagerBaseUrl } from "../services/data-manager-client";

describe("DataManagerClient", () => {
  it("constructs the right URL for status", () => {
    const c = new DataManagerClient({ baseUrl: "http://data-manager:4000" });
    expect(c.statusUrl()).toBe("http://data-manager:4000/status");
  });

  it("trims trailing slash from baseUrl", () => {
    const c = new DataManagerClient({ baseUrl: "http://localhost:4000/" });
    expect(c.statusUrl()).toBe("http://localhost:4000/status");
  });

  it("rejects plaintext remote destinations before a token can be attached", () => {
    expect(
      () => new DataManagerClient({ baseUrl: "http://attacker.example", authToken: "secret" }),
    ).toThrow(/destination/i);
  });

  it("accepts plaintext hosts an operator explicitly allowlists", () => {
    expect(
      () => new DataManagerClient({ baseUrl: "http://10.0.0.5:4000", authToken: "secret" }),
    ).toThrow(/destination/i);
    expect(
      validateDataManagerBaseUrl("http://10.0.0.5:4000", { allowPlaintextHosts: ["10.0.0.5"] }),
    ).toBe("http://10.0.0.5:4000");
    process.env.DATA_MANAGER_PLAINTEXT_HOSTS = "dm.internal, 10.0.0.5";
    try {
      expect(validateDataManagerBaseUrl("http://DM.internal:4000")).toBe("http://dm.internal:4000");
    } finally {
      delete process.env.DATA_MANAGER_PLAINTEXT_HOSTS;
    }
  });

  it("rejects base URLs containing credentials, query strings, or path prefixes", () => {
    for (const baseUrl of [
      "https://user:pass@data-manager.example",
      "https://data-manager.example/prefix",
      "https://data-manager.example?target=other",
    ]) {
      expect(() => new DataManagerClient({ baseUrl })).toThrow(/base URL/i);
    }
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

    const client = new DataManagerClient({ baseUrl: "http://localhost:4000", fetch: fakeFetch });
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

    const client = new DataManagerClient({ baseUrl: "http://localhost:4000", fetch: fakeFetch });
    await expect(client.downloadOsm("planet")).rejects.toThrow("upstream 404");
  });

  it("posts /datasets/reload and returns the refreshed dataset count", async () => {
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return Response.json({ ok: true, datasets: 3 });
    }) as unknown as typeof globalThis.fetch;

    const client = new DataManagerClient({ baseUrl: "http://localhost:4000", fetch: fakeFetch });
    const result = await client.reloadDatasets();
    expect(result).toEqual({ ok: true, datasets: 3 });
  });

  it("posts /link with prune flag and parses linked/skipped/pruned counts", async () => {
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain('"prune":true');
      return Response.json({ ok: true, linked: 7, skipped: 2, pruned: 3 });
    }) as unknown as typeof globalThis.fetch;

    const client = new DataManagerClient({ baseUrl: "http://localhost:4000", fetch: fakeFetch });
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
      baseUrl: "http://localhost:4000/",
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
      "http://localhost:4000/search-index/build",
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
      baseUrl: "http://localhost:4000",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      authToken: "search-secret",
    });

    await expect(client.searchIndexStatus()).resolves.toEqual(status);
    const init = fakeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(fakeFetch.mock.calls[0]?.[0]).toBe("http://localhost:4000/search-index/status");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer search-secret");
  });

  it("preserves an absent search index as an HTTP 404 failure", async () => {
    const fakeFetch = vi.fn(async () =>
      Response.json({ ok: false, error: "osm_search index not built" }, { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const client = new DataManagerClient({ baseUrl: "http://localhost:4000", fetch: fakeFetch });

    const request = client.searchIndexStatus();
    await expect(request).rejects.toThrow("search-index/status failed: HTTP 404");
    await expect(request).rejects.toMatchObject({ status: 404 });
  });

  it("disables redirects, supplies a deadline signal, and bounds JSON bodies", async () => {
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ datasets: [{ padding: "x".repeat(1024) }] }), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.example",
      fetch: fakeFetch as typeof globalThis.fetch,
      maxJsonBytes: 128,
    });

    await expect(client.datasets()).rejects.toThrow(/too large/i);
  });

  it("bounds cumulative NDJSON progress bytes", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(`${JSON.stringify({ event: "progress", message: "x".repeat(256) })}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        }),
    );
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.example",
      fetch: fakeFetch as typeof globalThis.fetch,
      maxStreamBytes: 64,
    });

    await expect(client.pullOverture("de")).rejects.toThrow(/too large/i);
  });

  it("aborts an ordinary request when its deadline expires", async () => {
    const fakeFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.example",
      fetch: fakeFetch as typeof globalThis.fetch,
      requestTimeoutMs: 5,
    });

    await expect(client.datasets()).rejects.toThrow(/timeout|aborted/i);
  });

  it("cancels a progress stream that stops emitting heartbeats", async () => {
    const cancel = vi.fn();
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel,
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    );
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.example",
      fetch: fakeFetch as typeof globalThis.fetch,
      streamIdleTimeoutMs: 5,
    });

    await expect(client.pullOverture("de")).rejects.toThrow(/idle timeout/i);
    expect(cancel).toHaveBeenCalled();
  });
});
