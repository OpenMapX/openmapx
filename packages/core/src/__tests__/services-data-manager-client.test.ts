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
});
