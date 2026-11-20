import { SafeFetchHttpError } from "@openmapx/core/server";
import type { CacheClient } from "@openmapx/integration-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MdbClient, type MdbJsonRequest } from "../client.js";

let nowMs: number;
const advance = (ms: number) => {
  nowMs += ms;
};

beforeEach(() => {
  nowMs = 1_700_000_000_000;
});

function requestMock(answer: (url: string) => unknown) {
  const request = vi.fn(async (url: string) => {
    const value = answer(url);
    if (value instanceof Error) throw value;
    return value;
  });
  return { request, client: request as unknown as MdbJsonRequest };
}

describe("MdbClient", () => {
  it("exchanges the refresh token and caches the access token until expiry", async () => {
    const { request, client: transport } = requestMock((url) =>
      url.endsWith("/v1/tokens") ? { access_token: "AT-1", expires_in: 3600 } : { results: [] },
    );
    const client = new MdbClient({ refreshToken: "RT", request: transport, now: () => nowMs });

    await client.listGtfsFeeds();
    // Two more calls within token TTL should NOT re-hit /v1/tokens
    advance(60_000);
    await client.listGtfsRtFeeds();
    advance(60_000);
    await client.listGbfsFeeds();

    const tokenCalls = request.mock.calls.filter(([url]) => url.endsWith("/v1/tokens"));
    expect(tokenCalls).toHaveLength(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ refresh_token: "RT" }),
      allowedRedirectOrigin: "https://api.mobilitydatabase.org",
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer AT-1" },
      allowedRedirectOrigin: "https://api.mobilitydatabase.org",
    });
  });

  it("refreshes the access token on 401 and retries the failing call", async () => {
    const answers: unknown[] = [
      { access_token: "AT-1", expires_in: 3600 },
      new SafeFetchHttpError(401, "https://api.mobilitydatabase.org/v1/gtfs_feeds", null),
      { access_token: "AT-2", expires_in: 3600 },
      { results: [] },
    ];
    const { request, client: transport } = requestMock(() => answers.shift());
    const client = new MdbClient({ refreshToken: "RT", request: transport, now: () => nowMs });

    expect(await client.listGtfsFeeds()).toEqual([]);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[3]?.[1]).toMatchObject({ headers: { Authorization: "Bearer AT-2" } });
  });

  it("does not retry a refused token exchange", async () => {
    const { request, client: transport } = requestMock(
      () => new SafeFetchHttpError(401, "https://api.mobilitydatabase.org/v1/tokens", null),
    );
    const client = new MdbClient({ refreshToken: "RT", request: transport, now: () => nowMs });

    await expect(client.listGtfsFeeds()).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials on an operator-configured origin", async () => {
    const { request, client: transport } = requestMock((url) =>
      url.endsWith("/v1/tokens") ? { access_token: "AT", expires_in: 3600 } : [],
    );
    const client = new MdbClient({
      refreshToken: "RT",
      baseUrl: "https://mirror.example/mdb/",
      request: transport,
      now: () => nowMs,
    });

    await client.listGtfsFeeds();

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://mirror.example/mdb/v1/tokens",
      "https://mirror.example/mdb/v1/gtfs_feeds?limit=100&offset=0",
    ]);
    for (const [, options] of request.mock.calls) {
      expect(options?.allowedRedirectOrigin).toBe("https://mirror.example");
    }
  });

  it("paginates until MDB returns a short page", async () => {
    const page = (offset: number, count: number) => ({
      results: Array.from({ length: count }, (_, i) => ({
        id: `mdb-${offset + i}`,
        data_type: "gtfs",
      })),
    });
    const { client: transport } = requestMock((input) => {
      const url = new URL(input);
      if (url.pathname === "/v1/tokens") return { access_token: "AT", expires_in: 3600 };
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (offset === 0) return page(0, 100);
      if (offset === 100) return page(100, 100);
      return page(200, 17); // short page → done
    });
    const client = new MdbClient({ refreshToken: "RT", request: transport, now: () => nowMs });

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
    };
    const { request, client: transport } = requestMock(() => ({}));
    const client = new MdbClient({
      refreshToken: "RT",
      cache,
      request: transport,
      now: () => nowMs,
    });
    const feeds = await client.listGtfsFeeds();
    expect(feeds).toEqual(cached);
    expect(request).not.toHaveBeenCalled();
  });
});
