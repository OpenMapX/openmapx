import type { SharedRequestPolicy, UpstreamRuntime } from "@openmapx/integration-framework";
import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMbtaClient } from "./client";
import {
  apiWebStopControllerIndex,
  apiWebStopControllerShow,
  getApiWebStopControllerIndexUrl,
} from "./generated/client";
import { Predictions, Stops } from "./generated/models";
import { mbtaRequest } from "./transport";

export function runtime() {
  return {
    admitSharedRequest: vi.fn(
      async (_input: { scope: string; key: string; policy?: SharedRequestPolicy }) => ({
        allowed: true as const,
        remaining: 999,
      }),
    ),
    deferSharedRequests: vi.fn(async () => {}),
  };
}
function fixture(body: unknown = { data: [] }) {
  const http = fakeHttpClient(() => body);
  const shared = runtime();
  const generation = new AbortController();
  let allowed = true;
  const client = createMbtaClient({
    http,
    upstreamRuntime: shared as unknown as UpstreamRuntime,
    apiKey: "fixture-key",
    signal: generation.signal,
    isSourceAllowed: async () => allowed,
  });
  return {
    client,
    http,
    shared,
    generation,
    deny: () => {
      allowed = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("MBTA host transport", () => {
  it("uses generated requests, header credentials, version and bounded JSON:API host acquisition", async () => {
    const f = fixture();
    expect(await apiWebStopControllerIndex({}, { client: f.client })).toEqual({ data: [] });
    const call = f.http.calls[0];
    expect(call.method).toBe("getResponse");
    expect(call.url).toBe("https://api-v3.mbta.com/stops");
    expect(call.options).toMatchObject({
      headers: {
        "x-api-key": "fixture-key",
        "MBTA-Version": "2021-01-09",
        Accept: "application/vnd.api+json",
      },
      redirect: "error",
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 8000,
      contentTypes: ["application/vnd.api+json"],
    });
    expect(f.shared.admitSharedRequest.mock.calls[0][0]).toMatchObject({
      scope: "https://api-v3.mbta.com",
      policy: { limit: 1000, durationMs: 60000, minIntervalMs: 60 },
    });
    expect(f.shared.admitSharedRequest.mock.calls[0][0].key).not.toContain("fixture-key");
  });
  it("validates included data and null relationships without inventing missing resource identities", async () => {
    const f = fixture({
      data: [
        {
          type: "prediction",
          id: "p",
          attributes: { arrival_time: null, departure_time: null },
          relationships: { schedule: { data: null } },
        },
      ],
      included: [{ type: "route", id: "Red", attributes: { type: 1, color: "DA291C" } }],
    });
    const parsed = await f.client.request("/predictions", Predictions);
    expect(parsed.included?.[0].attributes).toMatchObject({ color: "DA291C" });
    expect(parsed.data[0].relationships?.schedule?.data).toBeNull();
    await expect(fixture({ data: [{}] }).client.request("/stops", Stops)).rejects.toMatchObject({
      kind: "payload",
    });
  });
  it.each([
    "https://evil.test/stops",
    "//evil.test/stops",
    "/../stops",
    "/stops#fragment",
    "/stops?api_key=secret",
    "/stops/%2e%2e",
    "/routes",
  ])("denies request authority %s before network", async (path) => {
    const f = fixture();
    await expect(f.client.request(path, Stops)).rejects.toMatchObject({ kind: "input" });
    expect(f.http.calls).toHaveLength(0);
  });
  it("refuses a wrong generated schema or method", async () => {
    const f = fixture();
    await expect(
      mbtaRequest("/stops", { client: f.client, method: "POST", schema: Stops }),
    ).rejects.toMatchObject({ kind: "input" });
    await expect(
      mbtaRequest("/stops", { client: f.client, method: "GET", schema: Predictions }),
    ).rejects.toMatchObject({ kind: "input" });
    expect(f.http.calls).toHaveLength(0);
  });
  it("encodes stop identifiers exactly once", async () => {
    const f = fixture({ data: { type: "stop", id: "a/b" } });
    await apiWebStopControllerShow("a/b", {}, { client: f.client });
    expect(f.http.calls[0].url).toContain("/stops/a%2Fb");
  });
  it.each([undefined, ""])("does not acquire anonymously with key %s", async (apiKey) => {
    const f = fixture();
    const client = createMbtaClient({
      http: f.http,
      upstreamRuntime: f.shared as unknown as UpstreamRuntime,
      apiKey,
      signal: f.generation.signal,
      isSourceAllowed: async () => true,
    });
    await expect(apiWebStopControllerIndex({}, { client })).rejects.toMatchObject({
      kind: "unconfigured",
    });
    expect(f.http.calls).toHaveLength(0);
  });
  it("requires shared admission and working store", async () => {
    const f = fixture();
    const absent = createMbtaClient({
      http: f.http,
      apiKey: "fixture-key",
      signal: f.generation.signal,
      isSourceAllowed: async () => true,
    });
    await expect(apiWebStopControllerIndex({}, { client: absent })).rejects.toMatchObject({
      kind: "unavailable",
    });
    f.shared.admitSharedRequest.mockResolvedValueOnce({
      allowed: false,
      reason: "store_unavailable",
      retryAfterMs: null,
    } as never);
    await expect(apiWebStopControllerIndex({}, { client: f.client })).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(f.http.calls).toHaveLength(0);
  });
  it("does not dispatch or publish when policy changes", async () => {
    const f = fixture();
    f.deny();
    await expect(apiWebStopControllerIndex({}, { client: f.client })).rejects.toMatchObject({
      kind: "policy",
    });
    expect(f.http.calls).toHaveLength(0);
    const late = fixture();
    late.http.getResponse = async () => {
      late.deny();
      return { status: 200, headers: {}, body: { data: [] } } as never;
    };
    await expect(apiWebStopControllerIndex({}, { client: late.client })).rejects.toMatchObject({
      kind: "policy",
    });
  });
  it("aborts stalled policy, admission and HTTP work", async () => {
    for (const phase of ["policy", "admission", "http"]) {
      const f = fixture();
      let entered = false;
      const stall = () => {
        entered = true;
        return new Promise<never>(() => {});
      };
      if (phase === "admission") f.shared.admitSharedRequest.mockImplementation(stall);
      if (phase === "http") f.http.getResponse = stall;
      const client =
        phase === "policy"
          ? createMbtaClient({
              http: f.http,
              apiKey: "fixture-key",
              signal: f.generation.signal,
              isSourceAllowed: stall,
              upstreamRuntime: f.shared as unknown as UpstreamRuntime,
            })
          : f.client;
      const pending = apiWebStopControllerIndex({}, { client });
      const rejection = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
      await vi.waitFor(() => expect(entered).toBe(true));
      f.generation.abort();
      await rejection;
    }
  });
  it.each([403, 404, 429, 500, 204])(
    "classifies HTTP %s without exposing raw payloads",
    async (status) => {
      const f = fixture({
        status,
        headers: {},
        body: { errors: [{ detail: "secret fixture-key" }] },
      });
      await expect(apiWebStopControllerIndex({}, { client: f.client })).rejects.toMatchObject({
        kind:
          status === 429
            ? "quota"
            : status === 403
              ? "auth"
              : status === 404
                ? "not_found"
                : "upstream",
      });
      try {
        await apiWebStopControllerIndex({}, { client: f.client });
      } catch (error) {
        expect(String(error)).not.toMatch(/secret|fixture-key/);
      }
    },
  );
  it.each([200, 429])(
    "shares provider reset cooldown on HTTP %s using epoch seconds",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
      const reset = Date.now() / 1000 + 40;
      const f = fixture({
        status,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        body: { data: [] },
      });
      await apiWebStopControllerIndex({}, { client: f.client }).catch(() => {});
      expect(f.shared.deferSharedRequests).toHaveBeenCalledWith(
        expect.objectContaining({ delayMs: 40000 }),
      );
    },
  );
});
describe("MBTA bounded pagination", () => {
  const params = {
    "filter[latitude]": "42.36",
    "filter[longitude]": "-71.06",
    "filter[radius]": 0.01,
    "page[limit]": 100,
    "page[offset]": 0,
  };
  function collect(f: ReturnType<typeof fixture>) {
    return f.client.collect(getApiWebStopControllerIndexUrl(params), (offset, signal) =>
      apiWebStopControllerIndex(
        { ...params, "page[offset]": offset },
        { client: f.client, signal },
      ),
    );
  }
  it("collects complete pages under admission and deduplicates identities", async () => {
    const f = fixture();
    f.http.getResponse = vi.fn(async (url) => ({
      status: 200,
      headers: {},
      body: url.includes("offset%5D=100")
        ? {
            data: [
              { type: "stop", id: "b" },
              { type: "stop", id: "a" },
            ],
          }
        : {
            data: [{ type: "stop", id: "a" }],
            links: {
              next: `https://api-v3.mbta.com${getApiWebStopControllerIndexUrl({ ...params, "page[offset]": 100 })}`,
            },
          },
    })) as never;
    const result = await collect(f);
    expect(result.data.map((x) => x.id)).toEqual(["a", "b"]);
    expect(f.shared.admitSharedRequest).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, null, ""])(
    "rejects a terminal next=%s that contradicts a later last page",
    async (next) => {
      const last = getApiWebStopControllerIndexUrl({ ...params, "page[offset]": 100 });
      const f = fixture({ data: [{ type: "stop", id: "a" }], links: { next, last } });
      await expect(collect(f)).rejects.toMatchObject({ kind: "payload" });
      expect(f.http.calls).toHaveLength(1);
    },
  );
  it.each(["", "https://evil.test/stops?page[limit]=100&page[offset]=0"])(
    "rejects invalid terminal pagination metadata %s",
    async (link) => {
      const f = fixture({ data: [], links: { next: null, last: link } });
      await expect(collect(f)).rejects.toMatchObject({ kind: "payload" });
    },
  );
  it("accepts a terminal last link matching the current page and query", async () => {
    const f = fixture({
      data: [{ type: "stop", id: "a" }],
      links: { next: null, last: getApiWebStopControllerIndexUrl(params) },
    });
    expect((await collect(f)).data.map((x) => x.id)).toEqual(["a"]);
  });
  it.each([
    "https://evil.test/stops?page[offset]=100",
    "/vehicles?page[offset]=100",
    "/stops?page[offset]=0",
    "/stops?api_key=secret&page[offset]=100",
  ])("rejects unsafe or changed pagination %s", async (next) => {
    const f = fixture({ data: [{ type: "stop", id: "a" }], links: { next } });
    await expect(collect(f)).rejects.toMatchObject({ kind: "payload" });
    expect(f.http.calls).toHaveLength(1);
  });
  it("does not return a successful partial result after a later-page failure", async () => {
    const f = fixture();
    f.http.getResponse = vi.fn(async (url) => ({
      status: url.includes("offset%5D=100") ? 500 : 200,
      headers: {},
      body: {
        data: [{ type: "stop", id: "a" }],
        links: {
          next: `https://api-v3.mbta.com${getApiWebStopControllerIndexUrl({ ...params, "page[offset]": 100 })}`,
        },
      },
    })) as never;
    await expect(collect(f)).rejects.toMatchObject({ kind: "upstream" });
  });
});

describe("MBTA failure and lifetime boundaries", () => {
  it("sanitizes a failing policy dependency at every client entry point", async () => {
    const f = fixture();
    const client = createMbtaClient({
      http: f.http,
      upstreamRuntime: f.shared as unknown as UpstreamRuntime,
      apiKey: "fixture-key",
      signal: f.generation.signal,
      isSourceAllowed: async () => {
        throw new Error("private fixture-key");
      },
    });
    for (const run of [
      () => client.assertAvailable(),
      () => client.request("/stops", Stops),
      () => client.collect("/stops", async () => ({ data: [] })),
    ])
      await expect(run()).rejects.toMatchObject({
        kind: "unavailable",
        message: "MBTA request failed (unavailable)",
      });
    expect(f.http.calls).toHaveLength(0);
  });
  it("times out a stalled HTTP dependency without publishing its late result", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.http.getResponse = () => new Promise(() => {});
    const pending = apiWebStopControllerIndex({}, { client: f.client });
    const rejected = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits only for spacing and cancels the owned wait on shutdown", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.shared.admitSharedRequest.mockResolvedValue({
      allowed: false,
      reason: "spacing",
      retryAfterMs: 1000,
    } as never);
    const pending = apiWebStopControllerIndex({}, { client: f.client });
    const rejected = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    await vi.advanceTimersByTimeAsync(1);
    f.generation.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(f.http.calls).toHaveLength(0);
  });
  it("rejects endless pagination at the page ceiling", async () => {
    const f = fixture();
    const first = "/stops?page%5Blimit%5D=100&page%5Boffset%5D=0";
    let count = 0;
    await expect(
      f.client.collect(first, async (offset) => {
        count++;
        return {
          data: [{ type: "stop", id: String(offset) }],
          links: { next: `/stops?page%5Blimit%5D=100&page%5Boffset%5D=${offset + 100}` },
        };
      }),
    ).rejects.toMatchObject({ kind: "payload" });
    expect(count).toBe(50);
  });
});
