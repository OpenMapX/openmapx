import { Readable } from "node:stream";
import { USER_AGENT } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import type { ResponseOptions, RouteHandler, StreamHttpResponse } from "../context";
import {
  createFencedMemoryCache,
  createMockIntegrationContext,
  createRecordingReply,
  type FakeHttpRequest,
  fakeHttpClient,
  httpStatus,
} from "../testing";
import {
  createTileProxyHandler,
  createUpstreamImageHandler,
  parseWebMercatorTileCoordinates,
  tileBoundsWebMercator,
} from "../tile-proxy";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function streamOf(bytes: Uint8Array, contentType?: string): StreamHttpResponse {
  return {
    status: 200,
    headers: contentType ? { "content-type": contentType } : {},
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

function request(params: Record<string, string>, signal?: AbortSignal) {
  return { query: {}, params, body: undefined, clientKey: "client", headers: {}, signal };
}

async function call(handler: RouteHandler, params: Record<string, string>) {
  const { reply, result } = createRecordingReply();
  await handler(request(params), reply);
  if (result.body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    result.body = Buffer.concat(chunks);
  }
  return result;
}

describe("parseWebMercatorTileCoordinates", () => {
  it.each([
    ["negative zoom", "-1", "0", "0", 22],
    ["fractional x", "1", "0.5", "0", 22],
    ["exponent notation", "1", "1e0", "0", 22],
    ["zoom above the provider ceiling", "23", "0", "0", 22],
    ["x outside the zoom world", "2", "4", "0", 22],
    ["y outside the zoom world", "2", "0", "4", 22],
    ["an encoded path segment", "2", "0", "..%2F..%2Fdata", 22],
    ["a decoded slash", "2", "0", "../../data", 22],
    ["unsafe decimal integer", "2", "9007199254740993", "0", 22],
  ])("rejects %s", (_label, z, x, y, maxZoom) => {
    expect(parseWebMercatorTileCoordinates(z, x, y, maxZoom)).toBeNull();
  });

  it("accepts the exact maximum tile and preserves decimal parsing", () => {
    expect(parseWebMercatorTileCoordinates("22", "04194303", "4194303", 22)).toEqual({
      z: 22,
      x: 4_194_303,
      y: 4_194_303,
    });
  });
});

describe("tileBoundsWebMercator", () => {
  it("covers the whole projected world at zoom 0 and a quadrant at zoom 1", () => {
    const half = 20_037_508.342789244;
    const world = tileBoundsWebMercator({ z: 0, x: 0, y: 0 });
    expect(world.map((value) => Math.round(value))).toEqual(
      [-half, -half, half, half].map(Math.round),
    );
    const northEast = tileBoundsWebMercator({ z: 1, x: 1, y: 0 });
    expect(northEast.map((value) => Math.round(value))).toEqual([0, 0, half, half].map(Math.round));
  });
});

describe("createTileProxyHandler", () => {
  const baseOptions = {
    kind: "raster" as const,
    label: "Test tile",
    cacheControl: "public, max-age=60",
    fallbackContentType: "image/png",
    url: ({ z, x, y }: { z: number; x: number; y: number }) =>
      `https://tiles.test/${z}/${x}/${y}.png?key=secret`,
  };

  it("streams a valid tile with its content type, cache headers and request options", async () => {
    const http = fakeHttpClient(() => streamOf(PNG, "image/png; charset=binary"));
    const ctx = createMockIntegrationContext({ http });

    const result = await call(createTileProxyHandler(ctx, baseOptions), { z: "3", x: "4", y: "5" });

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/png");
    expect(result.headers).toMatchObject({
      "cache-control": "public, max-age=60",
      "cross-origin-resource-policy": "cross-origin",
    });
    expect([...(result.body as Buffer)]).toEqual([...PNG]);
    const [call0] = http.calls;
    expect(call0?.method).toBe("getStream");
    expect(call0?.url).toBe("https://tiles.test/3/4/5.png?key=secret");
    const options = call0?.options as ResponseOptions;
    expect(options.maxBytes).toBe(8 * 1024 * 1024);
    expect(options.contentTypes).toContain("image/png");
    expect(options.contentTypes).not.toContain("text/html");
    expect(options.fallbackContentType).toBe("image/png");
    expect(options.discardErrorBody).toBe(true);
    expect(options.timeoutMs).toBe(15_000);
    expect(options.headers?.["User-Agent"]).toBe(USER_AGENT);
  });

  it("uses the vector media types and byte ceiling for vector tiles", async () => {
    const http = fakeHttpClient(() => streamOf(PNG));
    const ctx = createMockIntegrationContext({ http });

    const result = await call(
      createTileProxyHandler(ctx, {
        ...baseOptions,
        kind: "vector",
        fallbackContentType: "application/vnd.mapbox-vector-tile",
      }),
      { z: "1", x: "0", y: "0" },
    );

    expect(result.contentType).toBe("application/vnd.mapbox-vector-tile");
    const options = http.calls[0]?.options as ResponseOptions;
    expect(options.maxBytes).toBe(2 * 1024 * 1024);
    expect(options.contentTypes).toContain("application/vnd.mapbox-vector-tile");
    expect(options.contentTypes).not.toContain("image/png");
  });

  it.each([
    ["fractional", { z: "3", x: "1.5", y: "2" }],
    ["above the maximum zoom", { z: "15", x: "0", y: "0" }],
    ["x outside the grid", { z: "2", x: "4", y: "0" }],
    ["an encoded slash kept inside the parameter", { z: "2", x: "0", y: "..%2Fapi" }],
    ["a decoded slash kept inside the parameter", { z: "2", x: "0", y: "../../api" }],
    ["missing", { z: "2", x: "0" }],
  ])("answers 400 for %s coordinates without an upstream request", async (_label, params) => {
    const http = fakeHttpClient(() => streamOf(PNG, "image/png"));
    const ctx = createMockIntegrationContext({ http });

    const result = await call(createTileProxyHandler(ctx, { ...baseOptions, maxZoom: 14 }), params);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid tile coordinates" });
    expect(http.calls).toHaveLength(0);
  });

  it("answers 400 when the URL builder refuses the request", async () => {
    const http = fakeHttpClient(() => streamOf(PNG, "image/png"));
    const ctx = createMockIntegrationContext({ http });

    const result = await call(createTileProxyHandler(ctx, { ...baseOptions, url: () => null }), {
      z: "1",
      x: "0",
      y: "0",
    });

    expect(result.status).toBe(400);
    expect(http.calls).toHaveLength(0);
  });

  it("removes a configured suffix from y", async () => {
    const http = fakeHttpClient(() => streamOf(PNG, "image/png"));
    const ctx = createMockIntegrationContext({ http });

    await call(createTileProxyHandler(ctx, { ...baseOptions, ySuffix: ".png" }), {
      z: "2",
      x: "1",
      y: "3.png",
    });

    expect(http.calls[0]?.url).toBe("https://tiles.test/2/1/3.png?key=secret");
  });

  it.each([
    [404, 404, { error: "Test tile not found" }],
    [401, 502, { error: "Test tile unavailable" }],
    [403, 502, { error: "Test tile unavailable" }],
    [429, 502, { error: "Test tile unavailable" }],
    [503, 502, { error: "Test tile unavailable" }],
  ])("maps upstream %i to %i", async (upstream, expected, body) => {
    const warnings: string[] = [];
    const ctx = createMockIntegrationContext({
      http: fakeHttpClient(() => httpStatus(upstream)),
      log: {
        info: () => {},
        debug: () => {},
        error: () => {},
        warn: (message: string) => warnings.push(message),
      },
    });

    const result = await call(createTileProxyHandler(ctx, baseOptions), { z: "1", x: "0", y: "0" });

    expect(result.status).toBe(expected);
    expect(result.body).toEqual(body);
    expect(warnings.join("\n")).not.toContain("secret");
    expect(warnings.join("\n")).not.toContain("tiles.test");
  });

  it("answers 204 with its own cache policy for configured empty statuses", async () => {
    const ctx = createMockIntegrationContext({ http: fakeHttpClient(() => httpStatus(404)) });

    const result = await call(
      createTileProxyHandler(ctx, {
        ...baseOptions,
        empty: { statuses: [404], cacheControl: "public, max-age=86400" },
      }),
      { z: "1", x: "0", y: "0" },
    );

    expect(result.status).toBe(204);
    expect(result.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("answers 502 without the URL when the host refuses the body", async () => {
    const warnings: string[] = [];
    const ctx = createMockIntegrationContext({
      http: fakeHttpClient(() => {
        throw new Error("integration HTTP response too large (stream exceeds maxBytes)");
      }),
      log: {
        info: () => {},
        debug: () => {},
        error: () => {},
        warn: (message: string) => warnings.push(message),
      },
    });

    const result = await call(createTileProxyHandler(ctx, baseOptions), { z: "1", x: "0", y: "0" });

    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "Test tile unavailable" });
    expect(warnings).toEqual([
      "Test tile request failed: integration HTTP response too large (stream exceeds maxBytes)",
    ]);
  });

  it("computes Cache-Control from the request and passes extra headers and the timeout", async () => {
    const http = fakeHttpClient(() => streamOf(PNG, "image/jpeg"));
    const ctx = createMockIntegrationContext({ http });

    const result = await call(
      createTileProxyHandler(ctx, {
        ...baseOptions,
        timeoutMs: 25_000,
        headers: { Accept: "image/*" },
        cacheControl: (req) => `public, max-age=${req.params.z === "1" ? 10 : 20}`,
      }),
      { z: "1", x: "0", y: "0" },
    );

    expect(result.headers["cache-control"]).toBe("public, max-age=10");
    expect(result.contentType).toBe("image/jpeg");
    const options = http.calls[0]?.options as ResponseOptions;
    expect(options.timeoutMs).toBe(25_000);
    expect(options.headers?.Accept).toBe("image/*");
  });

  describe("cached mode", () => {
    const cachedOptions = {
      ...baseOptions,
      cache: {
        key: ({ z, x, y }: { z: number; x: number; y: number }) => `t:${z}:${x}:${y}`,
        ttlSeconds: 60,
      },
    };

    it("buffers the tile once and serves later requests from the cache", async () => {
      const http = fakeHttpClient(() => streamOf(PNG, "image/jpeg"));
      const cache = createFencedMemoryCache();
      const ctx = createMockIntegrationContext({ http, cache });
      const handler = createTileProxyHandler(ctx, cachedOptions);

      const first = await call(handler, { z: "2", x: "1", y: "1" });
      const second = await call(handler, { z: "2", x: "1", y: "1" });

      expect(http.calls.map((c: FakeHttpRequest) => c.method)).toEqual(["getStream"]);
      expect((http.calls[0]?.options as ResponseOptions).discardErrorBody).toBe(true);
      for (const result of [first, second]) {
        expect(result.status).toBe(200);
        expect(result.contentType).toBe("image/jpeg");
        expect([...(result.body as Buffer)]).toEqual([...PNG]);
      }
      expect(await cache.get("t:2:1:1")).toEqual({
        data: Buffer.from(PNG).toString("base64"),
        contentType: "image/jpeg",
      });
    });

    it("refetches an entry whose content type is not allowed", async () => {
      const http = fakeHttpClient(() => streamOf(PNG));
      const cache = createFencedMemoryCache();
      await cache.set("t:2:1:1", { data: "AAAA" });
      const ctx = createMockIntegrationContext({ http, cache });

      const result = await call(createTileProxyHandler(ctx, cachedOptions), {
        z: "2",
        x: "1",
        y: "1",
      });

      expect(http.calls).toHaveLength(1);
      expect(result.contentType).toBe("image/png");
    });

    it("answers 404 for an upstream 404 without caching it", async () => {
      const http = fakeHttpClient(() => httpStatus(404, { "Content-Type": "text/html" }));
      const cache = createFencedMemoryCache();
      const ctx = createMockIntegrationContext({ http, cache });

      const result = await call(createTileProxyHandler(ctx, cachedOptions), {
        z: "1",
        x: "0",
        y: "0",
      });

      expect(result.status).toBe(404);
      expect(await cache.get("t:1:0:0")).toBeNull();
    });

    it("does not cache an upstream failure", async () => {
      let attempt = 0;
      const http = fakeHttpClient(() => (++attempt === 1 ? httpStatus(503) : streamOf(PNG)));
      const cache = createFencedMemoryCache();
      const ctx = createMockIntegrationContext({ http, cache });
      const handler = createTileProxyHandler(ctx, cachedOptions);

      expect((await call(handler, { z: "1", x: "0", y: "0" })).status).toBe(502);
      expect((await call(handler, { z: "1", x: "0", y: "0" })).status).toBe(200);
      expect(http.calls).toHaveLength(2);
    });
  });
});

describe("createUpstreamImageHandler", () => {
  it("proxies a fixed image and answers 400 when the URL builder refuses", async () => {
    const http = fakeHttpClient(() => streamOf(PNG, "image/png"));
    const ctx = createMockIntegrationContext({ http });
    const handler = createUpstreamImageHandler(ctx, {
      kind: "raster",
      label: "Legend",
      cacheControl: "public, max-age=1",
      fallbackContentType: "image/png",
      maxBytes: 1_024,
      url: (req) =>
        /^[\w-]+\.png$/.test(req.params.file ?? "")
          ? `https://legends.test/${req.params.file}`
          : null,
    });

    const ok = await call(handler, { file: "a.png" });
    const refused = await call(handler, { file: "../a.png" });

    expect(ok.status).toBe(200);
    expect((http.calls[0]?.options as ResponseOptions).maxBytes).toBe(1_024);
    expect(refused.status).toBe(400);
    expect(http.calls).toHaveLength(1);
  });
});
