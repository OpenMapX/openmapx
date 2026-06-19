import { OverpassTimeoutError } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";

type RouteHandler = (
  req: { query: Record<string, string | undefined>; params: Record<string, string>; body: unknown },
  reply: FakeReply,
) => Promise<void> | void;

interface FakeReply {
  header: (k: string, v: string) => FakeReply;
  send: (p: unknown) => FakeReply;
  status: (n: number) => FakeReply;
  payload: unknown;
  statusCode: number;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    payload: undefined,
    statusCode: 200,
    header() {
      return reply;
    },
    send(p) {
      reply.payload = p;
      return reply;
    },
    status(n) {
      reply.statusCode = n;
      return reply;
    },
  };
  return reply;
}

function makeRouteCtx(orchestratorOverrides?: {
  searchByFilter?: (...args: unknown[]) => Promise<unknown>;
}): IntegrationContext & { routes: Map<string, RouteHandler> } {
  const routes = new Map<string, RouteHandler>();
  const ctx = {
    registerRoute(method: string, path: string, handler: RouteHandler) {
      routes.set(`${method} ${path}`, handler);
    },
    getIntegrationsByDomain: () => [],
    getRequiredService: () => ({}),
    cache: {
      async withCache<T>(_k: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    routes,
    ...(orchestratorOverrides ?? {}),
  } as unknown as IntegrationContext & { routes: Map<string, RouteHandler> };
  return ctx;
}

const VALID_FILTER = {
  selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
};

const VALID_BBOX = { south: 48.85, west: 2.33, north: 48.87, east: 2.37 };

function getHandler(ctx: IntegrationContext & { routes: Map<string, RouteHandler> }): RouteHandler {
  const handler = ctx.routes.get("POST /filter");
  if (!handler) throw new Error("POST /filter not registered");
  return handler;
}

describe("POST /filter route", () => {
  it("200 with { results, partial } for a valid filter + bbox", async () => {
    const fakeResults = [{ id: "osm:node/1", name: "Test Cafe", coordinates: [2.35, 48.86] }];

    const ctx = makeRouteCtx();

    // Stub getIntegrationsByDomain so the orchestrator resolves a real provider
    const searchByFilterMock = vi.fn(async () => fakeResults);
    (ctx as unknown as Record<string, unknown>).getIntegrationsByDomain = () => [
      {
        providers: new Map([
          [
            "poi-search",
            [
              {
                id: "fake-overpass",
                categories: [],
                search: vi.fn(),
                searchByFilter: searchByFilterMock,
              },
            ],
          ],
        ]),
      },
    ];

    setup(ctx);
    const handler = getHandler(ctx);

    const reply = makeReply();
    await handler(
      {
        query: {},
        params: {},
        body: { filter: VALID_FILTER, ...VALID_BBOX },
      },
      reply,
    );

    expect(reply.statusCode).toBe(200);
    const payload = reply.payload as { results: unknown[]; partial: boolean };
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results).toHaveLength(1);
    expect(typeof payload.partial).toBe("boolean");
  });

  it("400 for an invalid filter (empty selectors array)", async () => {
    const ctx = makeRouteCtx();
    setup(ctx);
    const handler = getHandler(ctx);

    const reply = makeReply();
    await handler(
      {
        query: {},
        params: {},
        body: { filter: { selectors: [] }, ...VALID_BBOX },
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    const payload = reply.payload as { error: string };
    expect(typeof payload.error).toBe("string");
    expect(payload.error).toMatch(/selectors/i);
  });

  it("400 for non-finite bbox value (east = NaN string)", async () => {
    const ctx = makeRouteCtx();
    setup(ctx);
    const handler = getHandler(ctx);

    const reply = makeReply();
    await handler(
      {
        query: {},
        params: {},
        body: {
          filter: VALID_FILTER,
          south: 48.85,
          west: 2.33,
          north: 48.87,
          east: "not-a-number",
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    const payload = reply.payload as { error: string };
    expect(payload.error).toMatch(/east/i);
  });

  it("400 for missing filter object", async () => {
    const ctx = makeRouteCtx();
    setup(ctx);
    const handler = getHandler(ctx);

    const reply = makeReply();
    await handler(
      {
        query: {},
        params: {},
        body: { filter: null, ...VALID_BBOX },
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
  });

  it("422 when orchestrator throws OverpassTimeoutError", async () => {
    const ctx = makeRouteCtx();

    (ctx as unknown as Record<string, unknown>).getIntegrationsByDomain = () => [
      {
        providers: new Map([
          [
            "poi-search",
            [
              {
                id: "fake-overpass",
                categories: [],
                search: vi.fn(),
                searchByFilter: vi.fn(async () => {
                  throw new OverpassTimeoutError("timeout");
                }),
              },
            ],
          ],
        ]),
      },
    ];

    setup(ctx);
    const handler = getHandler(ctx);

    const reply = makeReply();
    await handler(
      {
        query: {},
        params: {},
        body: { filter: VALID_FILTER, ...VALID_BBOX },
      },
      reply,
    );

    expect(reply.statusCode).toBe(422);
    expect(reply.payload).toEqual({ error: "area_too_large" });
  });

  it("sets Cache-Control header on success", async () => {
    const ctx = makeRouteCtx();

    (ctx as unknown as Record<string, unknown>).getIntegrationsByDomain = () => [
      {
        providers: new Map([
          [
            "poi-search",
            [
              {
                id: "fake-overpass",
                categories: [],
                search: vi.fn(),
                searchByFilter: vi.fn(async () => []),
              },
            ],
          ],
        ]),
      },
    ];

    setup(ctx);
    const handler = getHandler(ctx);

    const reply = makeReply();
    const headers: Record<string, string> = {};
    reply.header = (k: string, v: string) => {
      headers[k] = v;
      return reply;
    };

    await handler(
      {
        query: {},
        params: {},
        body: { filter: VALID_FILTER, ...VALID_BBOX },
      },
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect(headers["Cache-Control"]).toBe("public, max-age=300");
  });
});
