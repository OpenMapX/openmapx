import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { controlledRequestLoggingOptions, uniformErrorHandler } from "../../server-wiring.js";
import { createSafePinoOptions } from "../../utils/safe-log-fields.js";

const databaseState = vi.hoisted(() => ({ rows: [] as { key: string; value: unknown }[] }));
vi.mock("../../db/index.js", () => ({
  db: { select: () => ({ from: async () => databaseState.rows }) },
}));
vi.mock("../../db/schema.js", () => ({ systemSettings: {} }));

import { invalidateMapSettings } from "../../utils/map-settings.js";

let app: FastifyInstance;

beforeAll(async () => {
  const { maptilerRoute } = await import("../maptiler.js");
  app = Fastify({ logger: false });
  app.setErrorHandler(uniformErrorHandler);
  await app.register(maptilerRoute);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

afterEach(() => {
  databaseState.rows = [];
  invalidateMapSettings();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /maptiler/*", () => {
  it.each([
    ["x outside the zoom world", "/maptiler/tiles/v3/2/4/0.pbf"],
    ["y outside the zoom world", "/maptiler/tiles/v3/2/0/4.pbf"],
    ["zoom above the provider ceiling", "/maptiler/tiles/v3/23/0/0.pbf"],
  ])("rejects %s before provider acquisition", async (_label, url) => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the exact zoom-22 maximum tile", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1]), {
            headers: { "Content-Type": "application/vnd.mapbox-vector-tile" },
          }),
      ),
    );

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/tiles/v3/22/4194303/4194303.pbf",
    });

    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["terrain-rgb-v2", "webp"],
    ["contours-v2", "pbf"],
  ])("proxies %s TileJSON and rewrites its %s tiles", async (tileset, extension) => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubEnv("PUBLIC_BASE_URL", "https://api.example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          tiles: [
            `https://api.maptiler.com/tiles/${tileset}/{z}/{x}/{y}.${extension}?key=upstream-key`,
          ],
        }),
      ),
    );

    const res = await app.inject({ method: "GET", url: `/maptiler/tiles/${tileset}/tiles.json` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tiles: [`https://api.example.test/api/maptiler/tiles/${tileset}/{z}/{x}/{y}.${extension}`],
    });
  });

  it("rewrites MapTiler style asset URLs to the API proxy", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    // The proxy base is taken from configuration (PUBLIC_BASE_URL / DOMAIN),
    // not from request headers — see `publicBaseUrl()` in maptiler.ts.
    vi.stubEnv("PUBLIC_BASE_URL", "https://api.example.test");
    const fetchMock = vi.fn(async () =>
      Response.json({
        version: 8,
        glyphs: "https://api.maptiler.com/fonts/Open Sans Regular/{range}.pbf?key=upstream-key",
        sprite: "https://api.maptiler.com/maps/bright-v2/sprite?key=upstream-key",
        sources: {
          openmaptiles: {
            type: "vector",
            url: "https://api.maptiler.com/tiles/v3/tiles.json?key=upstream-key",
          },
        },
        layers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/maps/bright-v2/style.json",
      headers: {
        host: "api.example.test",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.maptiler.com/maps/bright-v2/style.json?key=test-key"),
      expect.any(Object),
    );
    expect(res.json()).toMatchObject({
      glyphs: "https://api.example.test/api/maptiler/fonts/Open%20Sans%20Regular/{range}.pbf",
      sprite: "https://api.example.test/api/maptiler/maps/bright-v2/sprite",
      sources: {
        openmaptiles: {
          url: "https://api.example.test/api/maptiler/tiles/v3/tiles.json",
        },
      },
    });
  });

  it("proxies binary tile assets without exposing the key to the client URL", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/tiles/satellite-v2/4/8/5.jpg",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.maptiler.com/tiles/satellite-v2/4/8/5.jpg?key=test-key"),
      expect.any(Object),
    );
  });

  it.each([
    ["missing MIME", {}],
    ["wrong MIME", { "Content-Type": "text/html" }],
    [
      "oversized declared length",
      {
        "Content-Type": "image/png",
        "Content-Length": String(8 * 1024 * 1024 + 1),
      },
    ],
  ])("rejects a raster tile with %s", async (_label, headers) => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]), { headers })),
    );

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/tiles/satellite-v2/4/8/5.png",
    });

    expect(res.statusCode).toBe(502);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns a fixed no-store 502 when a streamed tile exceeds its byte limit", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
                controller.close();
              },
            }),
            { headers: { "Content-Type": "application/vnd.mapbox-vector-tile" } },
          ),
      ),
    );

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/tiles/v3/4/8/5.pbf",
    });

    expect(res.statusCode).toBe(502);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ error: "Internal Server Error" });
  });

  it("cancels a stalled provider stream when the client disconnects after the first chunk", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    let cancelled = false;
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
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
          { headers: { "Content-Type": "application/vnd.mapbox-vector-tile" } },
        );
      }),
    );
    if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${address.port}/maptiler/tiles/v3/2/1/1.pbf`,
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

  it("rejects a bodyless binary success response", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { headers: { "Content-Type": "image/png" } })),
    );

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/tiles/satellite-v2/4/8/5.png",
    });

    expect(res.statusCode).toBe(502);
  });

  it.each([
    ["missing MIME", {}],
    ["wrong MIME", { "Content-Type": "text/html" }],
    [
      "oversized declared length",
      {
        "Content-Type": "application/json",
        "Content-Length": String(2 * 1024 * 1024 + 1),
      },
    ],
  ])("rejects style JSON with %s", async (_label, headers) => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { headers })),
    );

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/maps/bright-v2/style.json",
    });

    expect(res.statusCode).toBe(502);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns a no-store 502 for malformed style JSON", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("{not-json", { headers: { "Content-Type": "application/json" } }),
      ),
    );

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/maps/bright-v2/style.json",
    });

    expect(res.statusCode).toBe(502);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ message: "MapTiler provider returned an invalid response" });
  });

  it("cancels a rejected upstream error body", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 502, headers: { "Content-Type": "text/plain" } },
          ),
      ),
    );

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/tiles/satellite-v2/4/8/5.png",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.statusCode).toBe(502);
    expect(cancelled).toBe(true);
  });

  it.each([
    ["sprite.json", "application/json"],
    ["sprite.png", "image/png"],
    ["sprite@2x.json", "application/json"],
    ["sprite@2x.png", "image/png"],
    ["sprite%402x.json", "application/json"],
    ["sprite%402x.png", "image/png"],
  ])("forwards %s with the filename MapTiler accepts", async (requested, contentType) => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    const fetchMock = vi.fn(
      async () =>
        new Response(contentType === "image/png" ? new Uint8Array([137, 80, 78, 71]) : "{}", {
          headers: { "content-type": contentType },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: `/maptiler/maps/bright-v2/${requested}` });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        `https://api.maptiler.com/maps/bright-v2/${requested.replace("%40", "@")}?key=test-key`,
      ),
      expect.any(Object),
    );
  });

  it("rejects unsupported paths", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn());

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/geocoding/berlin.json",
    });

    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 503 when no MapTiler key is configured", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/maps/bright-v2/style.json",
    });

    expect(res.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs a failed upstream only as a host/digest summary and safe error class", async () => {
    vi.stubEnv("MAPTILER_KEY", "fixture-maptiler-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          "failed https://api.maptiler.com/maps/private-style-id/style.json?key=fixture-maptiler-key",
        );
      }),
    );
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const loggerApp = Fastify(
      controlledRequestLoggingOptions(pino(createSafePinoOptions("info"), stream)),
    );
    const { maptilerRoute } = await import("../maptiler.js");
    await loggerApp.register(maptilerRoute);
    await loggerApp.ready();

    const response = await loggerApp.inject({
      method: "GET",
      url: "/maptiler/maps/private-style-id/style.json",
    });
    await loggerApp.close();

    expect(response.statusCode).toBe(502);
    const warning = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.msg === "MapTiler proxy fetch failed");
    expect(warning).toMatchObject({
      upstream: { host: "api.maptiler.com", digest: "0d0cd3cdcbc3d368b8e43ff7f429df3c" },
      errorClass: "TypeError",
    });
    expect(chunks.join("")).not.toMatch(/private-style-id|fixture-maptiler-key/);
  });

  it("ignores X-Forwarded-Host when rewriting style URLs (cache-poisoning guard)", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubEnv("PUBLIC_BASE_URL", "https://api.example.test");
    const fetchMock = vi.fn(async () =>
      Response.json({
        version: 8,
        glyphs: "https://api.maptiler.com/fonts/Open Sans Regular/{range}.pbf?key=upstream-key",
        sprite: "https://api.maptiler.com/maps/bright-v2/sprite?key=upstream-key",
        sources: {},
        layers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/maps/bright-v2/style.json",
      headers: {
        host: "api.example.test",
        // Attacker tries to make the rewritten URLs point at their domain.
        "x-forwarded-host": "evil.attacker.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { glyphs: string; sprite: string };
    expect(body.glyphs).toContain("https://api.example.test/");
    expect(body.sprite).toContain("https://api.example.test/");
    expect(body.glyphs).not.toContain("attacker");
    expect(body.sprite).not.toContain("attacker");
  });
});

describe("admin-configured MapTiler credentials", () => {
  it("authenticates upstream requests with the effective database key without returning it", async () => {
    vi.stubEnv("MAPTILER_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
    databaseState.rows = [{ key: "maptilerApiKey", value: "admin-secret-key" }];
    vi.stubGlobal("fetch", async (url: URL) => {
      expect(url.searchParams.get("key")).toBe("admin-secret-key");
      return Response.json({
        tiles: ["https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=admin-secret-key"],
      });
    });
    const response = await app.inject("/maptiler/tiles/v3/tiles.json");
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("admin-secret-key");
    expect(response.json().tiles[0]).toContain("/api/maptiler/tiles/v3/");
  });
});
