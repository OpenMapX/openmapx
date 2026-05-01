import type { IntegrationContext, RouteHandler } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index";

interface RouteRegistration {
  method: string;
  path: string;
  handler: RouteHandler;
}

function buildCtx(overrides: { accessToken?: string } = {}) {
  const routes: RouteRegistration[] = [];
  const ctx = {
    config: { accessToken: overrides.accessToken ?? "TOKEN" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    cache: {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      withCache: vi.fn(async (_k: string, _t: number, fn: () => unknown) => fn()),
    },
    registerRoute: (method: string, path: string, handler: RouteHandler) => {
      routes.push({ method, path, handler });
    },
  } as unknown as IntegrationContext;
  return { ctx, routes };
}

type ReplyMock = Parameters<RouteHandler>[1];
type RequestMock = Parameters<RouteHandler>[0];

function makeReply(): ReplyMock {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn(),
    type: vi.fn(),
  } as unknown as ReplyMock;
}

function makeRequest(query: Record<string, string>): RequestMock {
  return { query, params: {}, body: undefined } as RequestMock;
}

function findRoute(routes: RouteRegistration[], path: string): RouteRegistration {
  const route = routes.find((r) => r.path === path);
  if (!route) throw new Error(`route not registered: ${path}`);
  return route;
}

describe("street-view-mapillary /streetview/images", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Mapillary now rejects /images bbox queries wider than ~0.0002 deg per side
  // (HTTP 500 "Please reduce the amount of data you're asking for"), so every
  // attempt — including widened retries — must stay under that ceiling.
  const MAPILLARY_MAX_SPAN = 0.0004 + 1e-9;

  it("uses a Mapillary-safe bbox (≤ 0.0004 deg span) on every attempt", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const route = findRoute(routes, "/streetview/images");
    await route.handler(makeRequest({ lat: "52.52", lng: "13.41" }), makeReply());

    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      const url = new URL(call[0] as string);
      const bbox = url.searchParams.get("bbox");
      expect(bbox).not.toBeNull();
      const [west, south, east, north] = (bbox as string).split(",").map(Number);
      expect(east - west).toBeLessThanOrEqual(MAPILLARY_MAX_SPAN);
      expect(north - south).toBeLessThanOrEqual(MAPILLARY_MAX_SPAN);
    }
  });

  it("retries with a slightly larger bbox when the first attempt finds no images", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "img2", geometry: { type: "Point", coordinates: [13.41, 52.52] } }],
        }),
      });

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const route = findRoute(routes, "/streetview/images");
    const reply = makeReply();
    await route.handler(makeRequest({ lat: "52.52", lng: "13.41" }), reply);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reply.send).toHaveBeenCalledWith({ id: "img2" });
  });

  it("returns 404 when no images are found even after expanding the bbox", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const route = findRoute(routes, "/streetview/images");
    const reply = makeReply();
    await route.handler(makeRequest({ lat: "52.52", lng: "13.41" }), reply);
    expect(reply.status).toHaveBeenCalledWith(404);
  });
});
