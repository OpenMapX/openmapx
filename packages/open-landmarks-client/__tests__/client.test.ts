import { createHash } from "node:crypto";
import type {
  BinaryHttpResponse,
  HttpResponse,
  LandmarkAsset,
  Logger,
  ResponseOptions,
} from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenLandmarksClient, type OpenLandmarksClientOptions } from "../client";
import { commonAssetFields } from "../normalize";
import type { OpenLandmarksAssetRecord } from "../schema";
import { fixture } from "./fixtures";

const BASE = "https://landmarks.barrelman.dev";
const MINUTE = 60_000;

type Route = { status: number; text?: string; bytes?: Uint8Array };

interface FakeHttp {
  routes: Map<string, Route>;
  calls: { url: string; options: ResponseOptions }[];
  fail: boolean;
  http: OpenLandmarksClientOptions["http"];
}

function fakeHttp(): FakeHttp {
  const state: FakeHttp = {
    routes: new Map(),
    calls: [],
    fail: false,
    http: undefined as never,
  };
  const lookup = (url: string, options: ResponseOptions): Route => {
    state.calls.push({ url, options });
    if (state.fail) throw new Error("network down");
    return state.routes.get(url) ?? { status: 404, text: "" };
  };
  state.http = {
    async getText(url, options): Promise<HttpResponse<string>> {
      const route = lookup(url, options);
      return { status: route.status, headers: {}, body: route.text ?? "" };
    },
    async getBytes(url, options): Promise<BinaryHttpResponse> {
      const route = lookup(url, options);
      return { status: route.status, headers: {}, bytes: route.bytes ?? new Uint8Array() };
    },
  };
  return state;
}

function silentLog(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function normalize(record: OpenLandmarksAssetRecord): LandmarkAsset | null {
  const fields = commonAssetFields(record);
  if (!fields) return null;
  return {
    ...fields,
    grounding: "anchor",
    derivedFootprintAllowed: false,
    reviewTier: "unreviewed",
    sourceId: "test",
    contributors: [],
  };
}

interface ReleaseDocs {
  release: string;
  assets: Record<string, unknown>[];
}

function serveRelease(http: FakeHttp, docs: ReleaseDocs): void {
  const pointer = fixture<Record<string, unknown>>("barrelman-pointer.json");
  const catalogue = fixture<Record<string, unknown>>("barrelman-catalogue.json");
  const cataloguePath = `/api/v1/releases/${docs.release}/catalogue.json`;
  const assetsPath = `/api/v1/releases/${docs.release}/assets.json`;
  http.routes.set(`${BASE}/api/v1/latest.json`, {
    status: 200,
    text: JSON.stringify({ ...pointer, release: docs.release, catalogue: cataloguePath }),
  });
  http.routes.set(`${BASE}${cataloguePath}`, {
    status: 200,
    text: JSON.stringify({ ...catalogue, release: docs.release, assets: assetsPath }),
  });
  http.routes.set(`${BASE}${assetsPath}`, {
    status: 200,
    text: JSON.stringify({ schemaVersion: 1, release: docs.release, assets: docs.assets }),
  });
}

function barrelmanAssets(): Record<string, unknown>[] {
  return fixture<{ assets: Record<string, unknown>[] }>("barrelman-assets.json").assets;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function client(http: FakeHttp, overrides: Partial<OpenLandmarksClientOptions> = {}) {
  return createOpenLandmarksClient({
    baseUrl: BASE,
    channel: "latest",
    retainsReleases: false,
    http: http.http,
    log: silentLog(),
    normalize,
    ...overrides,
  });
}

/** Give one asset a gzip descriptor matching `bytes`, served at its URL. */
function withModel(http: FakeHttp, asset: Record<string, unknown>, bytes: Uint8Array) {
  const low = (asset.lods as { low: { sha256: string; gzip: Record<string, unknown> } }).low;
  low.gzip = { ...low.gzip, sha256: sha256(bytes), bytes: bytes.byteLength };
  http.routes.set(`${BASE}${low.gzip.url as string}`, { status: 200, bytes });
  return low.sha256;
}

describe("createOpenLandmarksClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads pointer, catalogue and assets into a snapshot", async () => {
    const http = fakeHttp();
    serveRelease(http, { release: "r1", assets: barrelmanAssets() });
    const c = client(http);
    await c.refresh();
    const snapshot = c.snapshot();
    expect(snapshot?.release).toBe("r1");
    expect(snapshot?.assets.length).toBe(barrelmanAssets().length);
  });

  it("does not download assets again when the release is unchanged", async () => {
    const http = fakeHttp();
    serveRelease(http, { release: "r1", assets: barrelmanAssets() });
    const c = client(http);
    await c.refresh();
    http.calls.length = 0;
    await c.refresh();
    expect(http.calls.map((call) => call.url)).toEqual([`${BASE}/api/v1/latest.json`]);
  });

  it("re-reads the pointer once when the catalogue answers 404", async () => {
    const http = fakeHttp();
    serveRelease(http, { release: "r1", assets: barrelmanAssets() });
    http.routes.delete(`${BASE}/api/v1/releases/r1/catalogue.json`);
    const c = client(http);
    await expect(c.refresh()).rejects.toThrow();
    const pointerReads = http.calls.filter((call) => call.url.endsWith("/latest.json"));
    expect(pointerReads).toHaveLength(2);
  });

  it("keeps the previous snapshot when the assets document fails validation", async () => {
    const http = fakeHttp();
    serveRelease(http, { release: "r1", assets: barrelmanAssets() });
    const c = client(http);
    await c.refresh();
    serveRelease(http, { release: "r2", assets: [] });
    http.routes.set(`${BASE}/api/v1/releases/r2/assets.json`, {
      status: 200,
      text: JSON.stringify({ schemaVersion: 1, release: "r2", assets: "not a list" }),
    });
    await expect(c.refresh()).rejects.toThrow();
    expect(c.snapshot()?.release).toBe("r1");
    expect(c.status().lastError).toBeTruthy();
  });

  it("returns an empty snapshot for a no-release pointer and never requests the other channel", async () => {
    const http = fakeHttp();
    http.routes.set(`${BASE}/api/v1/latest.json`, {
      status: 200,
      text: JSON.stringify({
        schemaVersion: 1,
        channel: "approved",
        status: "no-release",
        release: null,
        catalogue: null,
        count: 0,
      }),
    });
    const c = client(http);
    await c.refresh();
    expect(c.snapshot()).toMatchObject({ release: "none", assets: [] });
    expect(http.calls.map((call) => call.url)).toEqual([`${BASE}/api/v1/latest.json`]);
  });

  it("reads the preview pointer for the preview channel", async () => {
    const http = fakeHttp();
    const c = client(http, { channel: "preview" });
    await expect(c.refresh()).rejects.toThrow();
    expect(http.calls[0]?.url).toBe(`${BASE}/api/v1/preview.json`);
  });

  it("resolves root-relative catalogue and model paths against the base URL", async () => {
    const http = fakeHttp();
    serveRelease(http, { release: "r1", assets: barrelmanAssets() });
    const c = client(http);
    await c.refresh();
    expect(http.calls.every((call) => call.url.startsWith(`${BASE}/`))).toBe(true);
  });

  it("fetchModelGzip returns ok with verified bytes", async () => {
    const http = fakeHttp();
    const assets = barrelmanAssets();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha = withModel(http, assets[0] as Record<string, unknown>, bytes);
    serveRelease(http, { release: "r1", assets });
    const c = client(http);
    await c.refresh();
    const result = await c.fetchModelGzip(sha, new AbortController().signal);
    expect(result).toEqual({ status: "ok", gzip: bytes });
  });

  it("fetchModelGzip returns unlisted for an unknown sha256", async () => {
    const http = fakeHttp();
    serveRelease(http, { release: "r1", assets: barrelmanAssets() });
    const c = client(http);
    await c.refresh();
    http.calls.length = 0;
    const result = await c.fetchModelGzip("f".repeat(64), new AbortController().signal);
    expect(result).toEqual({ status: "unlisted" });
    expect(http.calls).toHaveLength(0);
  });

  it("gone schedules one early refresh", async () => {
    const http = fakeHttp();
    const assets = barrelmanAssets();
    const sha = withModel(http, assets[0] as Record<string, unknown>, new Uint8Array([9]));
    serveRelease(http, { release: "r1", assets });
    const url = [...http.routes.keys()].find((key) => key.endsWith(".glb.gz")) as string;
    http.routes.set(url, { status: 404 });
    const c = client(http);
    await c.refresh();
    http.calls.length = 0;
    expect(await c.fetchModelGzip(sha, new AbortController().signal)).toEqual({
      status: "gone",
    });
    expect(await c.fetchModelGzip(sha, new AbortController().signal)).toEqual({
      status: "gone",
    });
    await vi.advanceTimersByTimeAsync(0);
    const pointerReads = http.calls.filter((call) => call.url.endsWith("/latest.json"));
    expect(pointerReads).toHaveLength(1);
  });

  it("throws on a hash mismatch and on status 500", async () => {
    const http = fakeHttp();
    const assets = barrelmanAssets();
    const sha = withModel(http, assets[0] as Record<string, unknown>, new Uint8Array([1]));
    serveRelease(http, { release: "r1", assets });
    const url = [...http.routes.keys()].find((key) => key.endsWith(".glb.gz")) as string;
    const c = client(http);
    await c.refresh();
    http.routes.set(url, { status: 200, bytes: new Uint8Array([2]) });
    await expect(c.fetchModelGzip(sha, new AbortController().signal)).rejects.toThrow(
      /hash mismatch/,
    );
    http.routes.set(url, { status: 500 });
    await expect(c.fetchModelGzip(sha, new AbortController().signal)).rejects.toThrow(/500/);
  });

  it("keeps previous-release models only when releases are retained", async () => {
    for (const retainsReleases of [true, false]) {
      const http = fakeHttp();
      const first = barrelmanAssets();
      const sha = withModel(http, first[0] as Record<string, unknown>, new Uint8Array([7]));
      serveRelease(http, { release: "r1", assets: first });
      const c = client(http, { retainsReleases });
      await c.refresh();
      serveRelease(http, { release: "r2", assets: barrelmanAssets().slice(1) });
      await c.refresh();
      const result = await c.fetchModelGzip(sha, new AbortController().signal);
      expect(result.status).toBe(retainsReleases ? "ok" : "unlisted");
    }
  });

  it("two assets sharing a sha256 resolve to one model entry", async () => {
    const http = fakeHttp();
    const assets = barrelmanAssets();
    const east = assets.find((a) => a.id === "la-vincent-thomas-bridge-east") as Record<
      string,
      unknown
    >;
    const west = assets.find((a) => a.id === "la-vincent-thomas-bridge-west") as Record<
      string,
      unknown
    >;
    const bytes = new Uint8Array([5, 5]);
    const sha = withModel(http, east, bytes);
    withModel(http, west, bytes);
    serveRelease(http, { release: "r1", assets });
    const c = client(http);
    await c.refresh();
    expect(await c.fetchModelGzip(sha, new AbortController().signal)).toEqual({
      status: "ok",
      gzip: bytes,
    });
  });

  it("drops invalid records and logs their count once per release", async () => {
    const http = fakeHttp();
    const log = silentLog();
    serveRelease(http, { release: "r1", assets: [...barrelmanAssets(), { id: "broken" }] });
    const c = client(http, { log });
    await c.refresh();
    await c.refresh();
    expect(c.snapshot()?.assets.length).toBe(barrelmanAssets().length);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls[0])).toContain("1");
  });

  it("passes redirect error and the size caps to every request", async () => {
    const http = fakeHttp();
    const assets = barrelmanAssets();
    const sha = withModel(http, assets[0] as Record<string, unknown>, new Uint8Array([1]));
    serveRelease(http, { release: "r1", assets });
    const c = client(http);
    await c.refresh();
    await c.fetchModelGzip(sha, new AbortController().signal);
    for (const call of http.calls) expect(call.options.redirect).toBe("error");
    const assetsCall = http.calls.find((call) => call.url.endsWith("/assets.json"));
    expect(assetsCall?.options.maxBytes).toBe(32 * 1024 * 1024);
    expect(assetsCall?.options.timeoutMs).toBe(60_000);
    const modelCall = http.calls.find((call) => call.url.endsWith(".glb.gz"));
    expect(modelCall?.options.maxBytes).toBe(4 * 1024 * 1024);
  });

  it("backs off from 1 minute doubling to 30 minutes after failures", async () => {
    const http = fakeHttp();
    http.fail = true;
    const c = client(http);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    const reads = () => http.calls.length;
    expect(reads()).toBe(1);
    const delays = [1, 2, 4, 8, 16, 30, 30];
    for (const minutes of delays) {
      await vi.advanceTimersByTimeAsync(minutes * MINUTE - 1);
      const before = reads();
      await vi.advanceTimersByTimeAsync(1);
      expect(reads(), `after ${minutes} min`).toBe(before + 1);
    }
    c.stop();
  });

  it("start never rejects when the first load fails", async () => {
    const http = fakeHttp();
    http.fail = true;
    const c = client(http);
    expect(() => c.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.status().lastError).toBeTruthy();
    expect(c.snapshot()).toBeNull();
    c.stop();
  });

  it("stop prevents further refreshes", async () => {
    const http = fakeHttp();
    serveRelease(http, { release: "r1", assets: barrelmanAssets() });
    const c = client(http);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.stop();
    const before = http.calls.length;
    await vi.advanceTimersByTimeAsync(7 * 60 * MINUTE);
    expect(http.calls.length).toBe(before);
  });
});
