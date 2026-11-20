import { gzipSync } from "node:zlib";
import type { RouteHandler } from "@openmapx/integration-framework";
import { createRecordingReply } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { createModelProxy, type ModelProxyOptions } from "../model-proxy";
import {
  BARRELMAN,
  contextWith,
  type FakeProvider,
  fakeProvider,
  SHA,
  testAsset,
} from "./provider-fixtures";

const RAW = new TextEncoder().encode("glTF-binary-model-bytes");
const GZIP = new Uint8Array(gzipSync(RAW));
const MIB = 1024 * 1024;

function setup(
  options: ModelProxyOptions = {},
  provider: FakeProvider = fakeProvider(BARRELMAN, [testAsset()]),
) {
  const ctx = contextWith([provider]);
  let clock = 0;
  const proxy = createModelProxy(ctx, { now: () => clock, ...options });
  return {
    provider,
    proxy,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function request(
  handle: RouteHandler,
  params: Record<string, string>,
  headers: Record<string, string> = { "accept-encoding": "gzip, br" },
  signal?: AbortSignal,
) {
  const { reply, result } = createRecordingReply();
  await handle(
    {
      query: {},
      params,
      body: undefined,
      clientKey: "k",
      headers,
      ...(signal ? { signal } : {}),
    } as Parameters<RouteHandler>[0],
    reply,
  );
  return result;
}

const model = (n = 1) => ({ provider: BARRELMAN, sha256: SHA(n) });

describe("landmark model proxy", () => {
  it("serves gzip with content-encoding when accepted", async () => {
    const { provider, proxy } = setup();
    provider.fetch = async () => ({ status: "ok", gzip: GZIP });
    const result = await request(proxy.handle, model());
    expect(result.status).toBe(200);
    expect(result.headers["content-encoding"]).toBe("gzip");
    expect(new Uint8Array(result.body as Buffer)).toEqual(GZIP);
  });

  it("gunzips for clients without gzip", async () => {
    const { provider, proxy } = setup();
    provider.fetch = async () => ({ status: "ok", gzip: GZIP });
    const result = await request(proxy.handle, model(), {});
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(new Uint8Array(result.body as Buffer)).toEqual(RAW);
  });

  it("sets immutable caching and model content type", async () => {
    const { provider, proxy } = setup();
    provider.fetch = async () => ({ status: "ok", gzip: GZIP });
    const result = await request(proxy.handle, model());
    expect(result.headers["content-type"]).toBe("model/gltf-binary");
    expect(result.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(result.headers.vary).toBe("Accept-Encoding");
    expect(result.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("rejects a malformed sha256 with 400 no-store", async () => {
    const { proxy } = setup();
    const result = await request(proxy.handle, { provider: BARRELMAN, sha256: "ABC" });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "INVALID_MODEL_ID" });
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("404 for an unknown provider, an unlisted sha256 and a gone model, all no-store", async () => {
    const { provider, proxy } = setup();
    const unknown = await request(proxy.handle, { provider: "nobody", sha256: SHA(1) });
    expect(unknown.status).toBe(404);
    expect(unknown.headers["cache-control"]).toBe("no-store");
    for (const status of ["unlisted", "gone"] as const) {
      provider.fetch = async () => ({ status });
      const result = await request(proxy.handle, model(status === "gone" ? 2 : 3));
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ code: "UNKNOWN_MODEL" });
      expect(result.headers["cache-control"]).toBe("no-store");
    }
  });

  it("404 when the provider's model source is disallowed", async () => {
    const provider = fakeProvider(BARRELMAN, [testAsset()]);
    provider.fetch = async () => ({ status: "ok", gzip: GZIP });
    const proxy = createModelProxy(contextWith([provider], { disallowed: ["src"] }));
    expect((await request(proxy.handle, model())).status).toBe(404);
  });

  it("503 CATALOGUE_LOADING with Retry-After while the provider has no snapshot", async () => {
    const { proxy } = setup({}, fakeProvider(BARRELMAN, null));
    const result = await request(proxy.handle, model());
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: "CATALOGUE_LOADING" });
    expect(result.headers["retry-after"]).toBe("30");
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("502 on upstream failure is remembered for 60 seconds", async () => {
    const { provider, proxy, advance } = setup();
    const fetch = vi.fn(async () => {
      throw new Error("upstream down");
    });
    provider.fetch = fetch;
    const first = await request(proxy.handle, model());
    expect(first.status).toBe(502);
    expect(first.body).toEqual({ error: "Model unavailable", code: "UPSTREAM_UNAVAILABLE" });
    advance(59_000);
    expect((await request(proxy.handle, model())).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(2_000);
    await request(proxy.handle, model());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent requests for one model", async () => {
    const { provider, proxy } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => {
      await gate;
      return { status: "ok" as const, gzip: GZIP };
    });
    provider.fetch = fetch;
    const pending = Array.from({ length: 5 }, () => request(proxy.handle, model()));
    release();
    const results = await Promise.all(pending);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("limits concurrent upstream fetches and rejects beyond the queue with 503 BUSY", async () => {
    const { provider, proxy } = setup({ maxConcurrent: 2, maxQueue: 1 });
    let active = 0;
    let peak = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.fetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { status: "ok", gzip: GZIP };
    };
    const pending = [1, 2, 3].map((n) => request(proxy.handle, model(n)));
    const rejected = await request(proxy.handle, model(4));
    expect(rejected.status).toBe(503);
    expect(rejected.body).toMatchObject({ code: "BUSY" });
    expect(rejected.headers["retry-after"]).toBe("5");
    release();
    const results = await Promise.all(pending);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(peak).toBe(2);
  });

  it("rejects with 503 BUSY beyond the per-minute byte budget", async () => {
    const { provider, proxy, advance } = setup({ maxBytesPerMinute: GZIP.byteLength });
    provider.fetch = async () => ({ status: "ok", gzip: GZIP });
    expect((await request(proxy.handle, model(1))).status).toBe(200);
    const busy = await request(proxy.handle, model(2));
    expect(busy.status).toBe(503);
    expect(busy.body).toMatchObject({ code: "BUSY" });
    advance(60_001);
    expect((await request(proxy.handle, model(2))).status).toBe(200);
  });

  it("admits a model on its second request when the cache is above 75% full", async () => {
    const size = GZIP.byteLength;
    const { provider, proxy } = setup({ cacheBytes: Math.floor(size / 0.8) + 1 });
    const fetch = vi.fn(async () => ({ status: "ok" as const, gzip: GZIP }));
    provider.fetch = fetch;
    await request(proxy.handle, model(1)); // fills the cache to about 80%
    await request(proxy.handle, model(2)); // first request: not admitted
    await request(proxy.handle, model(2)); // second request: admitted
    await request(proxy.handle, model(2)); // served from cache
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(proxy.stats().hits).toBe(1);
  });

  it("evicts least recently used entries within the byte budget", async () => {
    const size = GZIP.byteLength;
    const { provider, proxy } = setup({ cacheBytes: size * 2 });
    const fetch = vi.fn(async () => ({ status: "ok" as const, gzip: GZIP }));
    provider.fetch = fetch;
    await request(proxy.handle, model(1));
    await request(proxy.handle, model(2));
    await request(proxy.handle, model(1)); // hit; model 2 is now least recent
    await request(proxy.handle, model(3)); // second-request rule: not admitted (cache full)
    await request(proxy.handle, model(3)); // admitted, evicting model 2
    await request(proxy.handle, model(1)); // still cached
    expect(proxy.stats().hits).toBe(2);
    await request(proxy.handle, model(2)); // evicted: fetched again
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("a requester disconnecting does not abort the shared fetch", async () => {
    const { provider, proxy } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: AbortSignal[] = [];
    provider.fetch = async (_sha, signal) => {
      seen.push(signal);
      await gate;
      return { status: "ok", gzip: GZIP };
    };
    const first = new AbortController();
    const a = request(proxy.handle, model(), { "accept-encoding": "gzip" }, first.signal);
    const b = request(proxy.handle, model());
    first.abort();
    release();
    const [, second] = await Promise.all([a, b]);
    expect(second.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(false);
  });

  it("caps gunzip output at 4 MiB", async () => {
    const { provider, proxy } = setup();
    provider.fetch = async () => ({
      status: "ok",
      gzip: new Uint8Array(gzipSync(new Uint8Array(4 * MIB + 1))),
    });
    const result = await request(proxy.handle, model(), {});
    expect(result.status).toBe(502);
  });
});
