import type { CacheClient } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MdbClient } from "../client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let nowMs: number;
const advance = (ms: number) => {
  nowMs += ms;
};

beforeEach(() => {
  nowMs = 1_700_000_000_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MdbClient", () => {
  it("exchanges the refresh token and caches the access token until expiry", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/tokens")) {
        return jsonResponse({ access_token: "AT-1", expires_in: 3600 });
      }
      return jsonResponse({ results: [] });
    });

    const client = new MdbClient({
      refreshToken: "RT",
      cache: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => nowMs,
    });

    await client.listGtfsFeeds();
    // Two more calls within token TTL should NOT re-hit /v1/tokens
    advance(60_000);
    await client.listGtfsRtFeeds();
    advance(60_000);
    await client.listGbfsFeeds();

    const tokenCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith("/v1/tokens"));
    expect(tokenCalls).toHaveLength(1);

    const authHeader = (fetchImpl.mock.calls[1]?.[1] as RequestInit)?.headers as Record<
      string,
      string
    >;
    expect(authHeader.Authorization).toBe("Bearer AT-1");
  });

  it("refreshes the access token on 401 and retries the failing call", async () => {
    const responses: Array<() => Response> = [
      // 1) initial token exchange
      () => jsonResponse({ access_token: "AT-1", expires_in: 3600 }),
      // 2) authed call → 401
      () => jsonResponse({ error: "expired" }, 401),
      // 3) re-exchange
      () => jsonResponse({ access_token: "AT-2", expires_in: 3600 }),
      // 4) authed call → 200
      () => jsonResponse({ results: [] }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()?.() ?? jsonResponse({}, 500));

    const client = new MdbClient({
      refreshToken: "RT",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => nowMs,
    });

    const feeds = await client.listGtfsFeeds();
    expect(feeds).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const retryAuthHeader = (fetchImpl.mock.calls[3]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(retryAuthHeader.Authorization).toBe("Bearer AT-2");
  });

  it("paginates until MDB returns a short page", async () => {
    const page = (offset: number, count: number) => ({
      results: Array.from({ length: count }, (_, i) => ({
        id: `mdb-${offset + i}`,
        data_type: "gtfs",
      })),
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/tokens") {
        return jsonResponse({ access_token: "AT", expires_in: 3600 });
      }
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (offset === 0) return jsonResponse(page(0, 100));
      if (offset === 100) return jsonResponse(page(100, 100));
      return jsonResponse(page(200, 17)); // short page → done
    });

    const client = new MdbClient({
      refreshToken: "RT",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => nowMs,
    });

    const feeds = await client.listGtfsFeeds();
    expect(feeds).toHaveLength(217);
    expect(feeds[0].id).toBe("mdb-0");
    expect(feeds[216].id).toBe("mdb-216");
  });

  it("returns the cached feed list when ctx.cache has a hit", async () => {
    const cached = [{ id: "mdb-cached", data_type: "gtfs" }];
    const cache: CacheClient = {
      get: vi.fn(async () => cached),
      set: vi.fn(async () => {}),
      del: vi.fn(async () => {}),
      withCache: vi.fn(),
      hmget: vi.fn(async (_key: string, fields: readonly string[]) => fields.map(() => null)),
    };
    const fetchImpl = vi.fn();
    const client = new MdbClient({
      refreshToken: "RT",
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => nowMs,
    });
    const feeds = await client.listGtfsFeeds();
    expect(feeds).toEqual(cached);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
