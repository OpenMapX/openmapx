import {
  createMockIntegrationContext,
  createPassthroughCache,
  createRecordingReply,
  fakeHttpClient,
  httpStatus,
} from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRainViewerTileUrl, canonicalizeRainViewerHost, setup } from "./index.js";

interface Sent {
  status: number;
  body: unknown;
}

async function callRadarMeta(host: string) {
  const http = fakeHttpClient({
    "api.rainviewer.com/public/weather-maps.json": {
      host,
      radar: {
        past: [{ time: 1, path: "/v2/radar/1" }],
        nowcast: [],
      },
    },
  });
  const cacheSet = vi.fn(async () => undefined);
  const cache = { ...createPassthroughCache(), set: cacheSet };
  const ctx = createMockIntegrationContext({ cache, http });
  setup(ctx);
  const route = ctx.registered.routes.find((candidate) => candidate.path === "/radar/meta");
  if (!route) throw new Error("no /radar/meta route");

  const sent: Sent = { status: 200, body: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  await route.handler({ query: {}, params: {}, headers: {} } as never, reply as never);
  return { cacheSet, sent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RainViewer metadata host", () => {
  it.each([
    ["https://rainviewer.com", "https://rainviewer.com"],
    ["https://RAINVIEWER.COM/", "https://rainviewer.com"],
    ["https://tilecache.rainviewer.com", "https://tilecache.rainviewer.com"],
    ["https://EU.TILECACHE.RAINVIEWER.COM:443/", "https://eu.tilecache.rainviewer.com"],
  ])("canonicalizes the trusted HTTPS origin %s", (input, expected) => {
    expect(canonicalizeRainViewerHost(input)).toBe(expected);
  });

  it.each([
    "http://rainviewer.com",
    "https://user:secret@rainviewer.com",
    "https://rainviewer.com:8443",
    "https://rainviewer.com/tiles",
    "https://rainviewer.com?target=attacker.example",
    "https://rainviewer.com#attacker.example",
    "https://attacker.example",
    "https://rainviewer.com.attacker.example",
    "https://notrainviewer.com",
  ])("rejects the untrusted or non-origin value %s", (input) => {
    expect(canonicalizeRainViewerHost(input)).toBeNull();
  });

  it("caches only the canonical trusted origin", async () => {
    const { cacheSet, sent } = await callRadarMeta("https://EU.TILECACHE.RAINVIEWER.COM:443/");

    expect(sent).toMatchObject({
      status: 200,
      body: { host: "https://eu.tilecache.rainviewer.com" },
    });
    expect(cacheSet).toHaveBeenCalledWith(
      "weather:radar:meta",
      expect.objectContaining({ host: "https://eu.tilecache.rainviewer.com" }),
      300,
    );
  });

  it("rejects metadata with an untrusted host before caching", async () => {
    const { cacheSet, sent } = await callRadarMeta("https://rainviewer.com.attacker.example");

    expect(sent).toEqual({ status: 502, body: { error: "RainViewer unavailable" } });
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("answers 502 without caching when RainViewer fails", async () => {
    const cacheSet = vi.fn(async () => undefined);
    const ctx = createMockIntegrationContext({
      cache: { ...createPassthroughCache(), set: cacheSet },
      http: fakeHttpClient(() => httpStatus(503)),
    });
    setup(ctx);
    const route = ctx.registered.routes.find((candidate) => candidate.path === "/radar/meta");
    const { reply, result } = createRecordingReply();
    await route?.handler(
      { query: {}, params: {}, body: undefined, clientKey: "c", headers: {} },
      reply,
    );

    expect(result).toMatchObject({ status: 502, body: { error: "RainViewer unavailable" } });
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it.each([
    ".attacker.example",
    "@127.0.0.1",
    "//attacker.example",
    "/v2/radar/1?target=attacker.example",
  ])("keeps the metadata frame path %s inside the trusted origin", (framePath) => {
    const tileUrl = new URL(
      buildRainViewerTileUrl("https://tilecache.rainviewer.com", framePath, "8", "130", "84"),
    );

    expect(tileUrl.origin).toBe("https://tilecache.rainviewer.com");
    expect(tileUrl.username).toBe("");
    expect(tileUrl.password).toBe("");
  });

  it("keeps a malicious cached frame path inside the trusted origin in the tile route", async () => {
    const framePath = ".attacker.example";
    const cache = {
      ...createPassthroughCache(),
      get: async <T>() =>
        ({
          host: "https://tilecache.rainviewer.com",
          past: [{ time: 1, path: framePath }],
          nowcast: [],
        }) as T,
    };
    const http = fakeHttpClient(() => ({
      status: 200,
      headers: { "content-type": "image/png" },
      stream: new Blob([new Uint8Array([1, 2, 3])]).stream(),
    }));
    const ctx = createMockIntegrationContext({ cache, http });
    setup(ctx);
    const route = ctx.registered.routes.find(
      (candidate) => candidate.path === "/radar/tile/:z/:x/:y",
    );
    if (!route) throw new Error("no radar tile route");
    const { reply, result } = createRecordingReply();

    await route.handler(
      {
        query: { path: framePath },
        params: { z: "8", x: "130", y: "84" },
        body: undefined,
        clientKey: "c",
        headers: {},
        signal: new AbortController().signal,
      },
      reply,
    );

    expect(result.status).toBe(200);
    expect(route.options?.rateLimitTier).toBe("tile");
    expect(http.calls).toHaveLength(1);
    const requestedUrl = new URL(http.calls[0]?.url ?? "");
    expect(requestedUrl.origin).toBe("https://tilecache.rainviewer.com");
    expect(requestedUrl.pathname).toContain("/.attacker.example/256/8/130/84/");
  });
});

describe("OpenWeatherMap tile route", () => {
  function owmRoute(responder: Parameters<typeof fakeHttpClient>[0]) {
    const http = fakeHttpClient(responder);
    const ctx = createMockIntegrationContext({ http, config: { owmApiKey: "owm-secret" } });
    setup(ctx);
    const route = ctx.registered.routes.find((r) => r.path === "/tiles/:layer/:z/:x/:y.png");
    if (!route) throw new Error("no OWM tile route");
    const call = async (params: Record<string, string>) => {
      const { reply, result } = createRecordingReply();
      await route.handler(
        { query: {}, params, body: undefined, clientKey: "c", headers: {} },
        reply,
      );
      return result;
    };
    return { http, route, call };
  }

  const png = () => ({
    status: 200,
    headers: { "content-type": "image/png" },
    stream: new Blob([new Uint8Array([1])]).stream(),
  });

  it("requests the validated tile with the key in the query on the tile tier", async () => {
    const { http, route, call } = owmRoute(png);

    const result = await call({ layer: "temp_new", z: "3", x: "4", y: "2" });

    expect(result.status).toBe(200);
    expect(route.options?.rateLimitTier).toBe("tile");
    expect(http.calls[0]?.url).toBe(
      "https://tile.openweathermap.org/map/temp_new/3/4/2.png?appid=owm-secret",
    );
  });

  it.each([
    ["an encoded slash in y", { z: "3", x: "4", y: "..%2F..%2Fdata%2F2.5%2Fweather" }],
    ["a decoded traversal in x", { z: "3", x: "../../data", y: "2" }],
    ["a fractional coordinate", { z: "3", x: "4.5", y: "2" }],
    ["x outside the zoom grid", { z: "3", x: "8", y: "2" }],
  ])("refuses %s before spending the key", async (_label, coordinates) => {
    const { http, call } = owmRoute(png);

    const result = await call({ layer: "temp_new", ...coordinates });

    expect(result.status).toBe(400);
    expect(http.calls).toHaveLength(0);
  });

  it("does not relay an upstream authorization failure to the browser", async () => {
    const { call } = owmRoute(() => httpStatus(401));
    const result = await call({ layer: "temp_new", z: "3", x: "4", y: "2" });
    expect(result.status).toBe(502);
  });

  it("refuses unknown layers", async () => {
    const { http, call } = owmRoute(png);
    expect((await call({ layer: "secret_layer", z: "1", x: "0", y: "0" })).status).toBe(400);
    expect(http.calls).toHaveLength(0);
  });
});
