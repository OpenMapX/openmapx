import type { CacheClient } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

function makeCache() {
  const values = new Map<string, unknown>();
  const cache: CacheClient = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    withCache: vi.fn(async (_key, _ttl, fn) => fn()),
  };
  return { cache, values };
}

function makeReply() {
  const result: { status: number; body?: unknown; headers: Record<string, string> } = {
    status: 200,
    headers: {},
  };
  const reply = {
    send: (body: unknown) => {
      result.body = body;
    },
    status: (status: number) => {
      result.status = status;
      return { send: (body: unknown) => (result.body = body) };
    },
    header: (name: string, value: string) => {
      result.headers[name] = value;
    },
    type: () => {},
  };
  return { reply, result };
}

const query = {
  name: "L'Osteria",
  country: "de",
  city: "Aachen",
  lat: "50.771968",
  lng: "6.085821",
};

describe("food-delivery routes", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function route(path: string, cache: CacheClient) {
    const ctx = createMockIntegrationContext({ cache });
    setup(ctx);
    const registered = ctx.registered.routes.find((candidate) => candidate.path === path);
    if (!registered) throw new Error(`missing route ${path}`);
    return registered.handler;
  }

  it("returns exact/search/browse metadata and caches a validated exact match", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: {
          feedItems: [
            {
              type: "REGULAR_STORE",
              store: {
                actionUrl: "/store/losteria/id",
                title: { text: "L'Osteria" },
                mapMarker: { latitude: 50.771968, longitude: 6.085821 },
              },
            },
          ],
        },
      }),
    );
    const { cache } = makeCache();
    const handler = route("/resolve", cache);
    const first = makeReply();
    await handler({ query, params: {}, body: undefined }, first.reply);
    const providers = (first.result.body as { providers: Array<{ id: string; linkKind: string }> })
      .providers;
    expect(providers.map(({ id, linkKind }) => [id, linkKind])).toEqual([
      ["ubereats", "exact"],
      ["wolt", "search"],
      ["lieferando", "browse"],
    ]);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining("resolve:v2:ubereats:de"),
      expect.objectContaining({ version: 2, kind: "exact" }),
      7 * 24 * 60 * 60,
    );

    const second = makeReply();
    await handler({ query, params: {}, body: undefined }, second.reply);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches only a valid no-match, not an upstream failure", async () => {
    const missState = makeCache();
    fetchMock.mockResolvedValueOnce(Response.json({ data: { feedItems: [] } }));
    const missHandler = route("/resolve", missState.cache);
    await missHandler({ query, params: {}, body: undefined }, makeReply().reply);
    expect(missState.cache.set).toHaveBeenCalledWith(
      expect.any(String),
      { version: 2, kind: "not_found" },
      24 * 60 * 60,
    );

    const errorState = makeCache();
    fetchMock.mockRejectedValue(new Error("upstream down"));
    const errorHandler = route("/resolve", errorState.cache);
    const errorReply = makeReply();
    await errorHandler({ query, params: {}, body: undefined }, errorReply.reply);
    await errorHandler({ query, params: {}, body: undefined }, makeReply().reply);
    expect(errorState.cache.set).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errorReply.result.headers["Cache-Control"]).toContain("no-store");
    expect(errorReply.result.body).toMatchObject({ degraded: true });
  });

  it("keeps the market catalog cheap and rejects invalid resolve queries", async () => {
    const { cache } = makeCache();
    const catalog = makeReply();
    await route("/providers", cache)(
      { query: { country: "de" }, params: {}, body: undefined },
      catalog.reply,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (catalog.result.body as { providers: Array<{ linkKind: string }> }).providers,
    ).toHaveLength(3);

    const invalid = makeReply();
    await route("/resolve", cache)({ query: {}, params: {}, body: undefined }, invalid.reply);
    expect(invalid.result.status).toBe(400);
  });
});
