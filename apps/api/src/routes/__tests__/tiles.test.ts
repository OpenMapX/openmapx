import { get } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { uniformErrorHandler } from "../../server-wiring.js";

let app: FastifyInstance;

beforeAll(async () => {
  const { tilesRoute } = await import("../tiles.js");
  app = Fastify({ logger: false });
  app.setErrorHandler(uniformErrorHandler);
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Access-Control-Expose-Headers", "ETag, Content-Range");
  });
  await app.register(tilesRoute);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pngResponseMock() {
  return vi.fn(
    async (..._args: unknown[]) =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  );
}

describe("GET /tiles/cyclosm — empty-string env regression", () => {
  // Compose injects optional vars as "" via `${CYCLOSM_TILE_URL:-}`. A
  // nullish `??` kept that empty string, so the route built `fetch("")` →
  // ERR_INVALID_URL → 502 in production while working in dev (where the var is
  // genuinely undefined). The route must treat blank as unset.
  it("falls back to the default CyclOSM URL when CYCLOSM_TILE_URL is empty", async () => {
    vi.stubEnv("THUNDERFOREST_API_KEY", undefined);
    vi.stubEnv("CYCLOSM_TILE_URL", "");
    const fetchMock = pngResponseMock();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/tiles/cyclosm/3/4/2.png" });

    expect(res.statusCode).toBe(200);
    // Subdomain rotates across {a,b,c}; assert the non-template part resolved.
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toMatch(
      /^https:\/\/[abc]\.tile-cyclosm\.openstreetmap\.fr\/cyclosm\/3\/4\/2\.png$/,
    );
  });
});

describe("cycling tile content receipts", () => {
  const receipts = (value: unknown) => JSON.parse(decodeURIComponent(String(value)));
  it("pairs each primary/fallback body with its own supplier and mandatory OSM notice", async () => {
    vi.stubEnv("THUNDERFOREST_API_KEY", "fixture-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([2]), { headers: { "Content-Type": "image/png" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const primary = await app.inject({ method: "GET", url: "/tiles/cyclosm/3/4/2.png" });
    const fallback = await app.inject({ method: "GET", url: "/tiles/cyclosm/3/5/2.png" });
    expect(primary.rawPayload).toEqual(Buffer.from([1]));
    expect(fallback.rawPayload).toEqual(Buffer.from([2]));
    expect(receipts(primary.headers["x-openmapx-contributors"])).toEqual([
      expect.objectContaining({ sourceId: "thunderforest", name: "Maps © Thunderforest" }),
      expect.objectContaining({
        sourceId: "openstreetmap",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Data",
              license: {
                kind: "spdx",
                expression: "ODbL-1.0",
                url: "https://opendatacommons.org/licenses/odbl/",
              },
            },
          ],
        } as const,
      }),
    ]);
    expect(receipts(fallback.headers["x-openmapx-contributors"])).toEqual([
      expect.objectContaining({
        sourceId: "cyclosm",
        publisher: { name: "OpenStreetMap France", url: "https://openstreetmap.fr/" },
      }),
      expect.objectContaining({
        sourceId: "openstreetmap",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Data",
              license: {
                kind: "spdx",
                expression: "ODbL-1.0",
                url: "https://opendatacommons.org/licenses/odbl/",
              },
            },
          ],
        } as const,
      }),
    ]);
    expect(primary.headers["cache-control"]).toContain("max-age=604800");
    expect(primary.headers["access-control-expose-headers"]).toContain("X-OpenMapX-Contributors");
    expect(primary.headers["access-control-expose-headers"]).toContain("ETag, Content-Range");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("cycling tile relay boundaries", () => {
  it.each([
    ["CyclOSM x outside the zoom-20 world", "/tiles/cyclosm/20/1048576/0.png"],
    ["CyclOSM zoom above its ceiling", "/tiles/cyclosm/21/0/0.png"],
    ["Waymarked y outside the zoom-18 world", "/tiles/cycling-routes/18/0/262144.png"],
    ["Waymarked zoom above its ceiling", "/tiles/cycling-routes/19/0/0.png"],
  ])("rejects %s before provider acquisition", async (_label, url) => {
    vi.stubEnv("THUNDERFOREST_API_KEY", undefined);
    const fetchMock = pngResponseMock();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["CyclOSM", "/tiles/cyclosm/20/1048575/1048575.png"],
    ["Waymarked", "/tiles/cycling-routes/18/262143/262143.png"],
  ])("accepts the exact %s maximum tile", async (_label, url) => {
    vi.stubEnv("THUNDERFOREST_API_KEY", undefined);
    vi.stubGlobal("fetch", pngResponseMock());

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["CyclOSM", "/tiles/cyclosm/3/4/2.png"],
    ["Waymarked", "/tiles/cycling-routes/3/4/2.png"],
  ])("rejects a non-PNG %s success response", async (_label, url) => {
    vi.stubEnv("THUNDERFOREST_API_KEY", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>not a tile</html>", { headers: { "Content-Type": "text/html" } }),
      ),
    );

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(502);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects an oversized Waymarked response from its declared length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1]), {
            headers: { "Content-Type": "image/png", "Content-Length": String(8 * 1024 * 1024 + 1) },
          }),
      ),
    );

    const res = await app.inject({
      method: "GET",
      url: "/tiles/cycling-routes/3/4/2.png",
    });

    expect(res.statusCode).toBe(502);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns a fixed no-store 502 when a streamed Waymarked tile exceeds its byte limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
                controller.close();
              },
            }),
            { headers: { "Content-Type": "image/png" } },
          ),
      ),
    );

    const res = await app.inject({
      method: "GET",
      url: "/tiles/cycling-routes/3/4/2.png",
    });

    expect(res.statusCode).toBe(502);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ error: "Internal Server Error" });
  });

  it("cancels a stalled Waymarked stream when the client disconnects after the first chunk", async () => {
    let cancelled = false;
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "image/png" } },
        );
      }),
    );
    if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${address.port}/tiles/cycling-routes/3/4/2.png`,
        (response) => {
          response.once("data", () => {
            response.destroy();
            request.destroy();
            resolve();
          });
          response.on("error", () => {});
        },
      );
      request.on("error", reject);
    });

    await vi.waitFor(() => {
      expect(fetchSignal?.aborted).toBe(true);
      expect(cancelled).toBe(true);
    });
  });

  it.each([
    ["CyclOSM", "/tiles/cyclosm/3/4/2.png"],
    ["Waymarked", "/tiles/cycling-routes/3/4/2.png"],
  ])("rejects a bodyless %s success response", async (_label, url) => {
    vi.stubEnv("THUNDERFOREST_API_KEY", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { headers: { "Content-Type": "image/png" } })),
    );

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(502);
  });
});
