import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ url: "http://tileserver:8080" as string | null }));
vi.mock("../service-registry.js", () => ({ serviceUrl: () => state.url }));

import { resetTileserverDatasets, tileserverDatasets } from "../tileserver-datasets.js";

function stubFetch(answer: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(answer);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  state.url = "http://tileserver:8080";
  resetTileserverDatasets();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("tileserverDatasets", () => {
  it("is null without a tileserver and probes nothing", async () => {
    state.url = null;
    const fetchMock = stubFetch(async () => new Response("{}"));
    expect(await tileserverDatasets()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [200, 200, { basemap: true, streetDetail: true }],
    [200, 404, { basemap: true, streetDetail: false }],
    [404, 200, { basemap: false, streetDetail: true }],
    [404, 404, { basemap: false, streetDetail: false }],
  ])("reports basemap %i and street detail %i", async (basemap, street, expected) => {
    const fetchMock = stubFetch(
      async (url) =>
        new Response("{}", { status: url.endsWith("/data/openmapx.json") ? basemap : street }),
    );
    expect(await tileserverDatasets()).toEqual(expected);
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      "http://tileserver:8080/data/openmapx.json",
      "http://tileserver:8080/data/street_detail.json",
    ]);
  });

  it("is null while the tileserver is unreachable", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await tileserverDatasets()).toBeNull();
  });

  it("gives up after one second", async () => {
    let signal: AbortSignal | undefined;
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason));
        }),
    );
    vi.useFakeTimers();
    const pending = tileserverDatasets();
    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
  });

  it("treats only a definite 404 as a missing archive; other errors leave the answer unknown", async () => {
    stubFetch(
      async (url) =>
        new Response("{}", { status: url.endsWith("/data/openmapx.json") ? 503 : 200 }),
    );
    expect(await tileserverDatasets()).toBeNull();
  });

  it("keeps the last good answer while the tileserver is briefly unreachable", async () => {
    vi.useFakeTimers();
    let down = false;
    const fetchMock = stubFetch(async (url) => {
      if (down) throw new TypeError("fetch failed");
      return new Response("{}", { status: url.endsWith("/data/openmapx.json") ? 404 : 200 });
    });
    expect(await tileserverDatasets()).toEqual({ basemap: false, streetDetail: true });
    down = true;
    vi.advanceTimersByTime(60_001);
    expect(await tileserverDatasets()).toEqual({ basemap: false, streetDetail: true });
    // A failure is not cached for a minute: the next request after a few seconds asks again.
    down = false;
    const calls = fetchMock.mock.calls.length;
    vi.advanceTimersByTime(5_001);
    expect(await tileserverDatasets()).toEqual({ basemap: false, streetDetail: true });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it("probes once per minute", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(async () => new Response("{}"));
    await tileserverDatasets();
    await Promise.all([tileserverDatasets(), tileserverDatasets()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_001);
    await tileserverDatasets();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
