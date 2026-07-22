import type { IntegrationContext, RouteHandler } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index";

interface RouteRegistration {
  method: string;
  path: string;
  handler: RouteHandler;
}

function buildCtx(overrides: { accessToken?: string } = {}) {
  const routes: RouteRegistration[] = [];
  const registerStreetLevelProvider = vi.fn();
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
    registerStreetLevelProvider,
  } as unknown as IntegrationContext;
  return { ctx, routes, registerStreetLevelProvider };
}

type ReplyMock = Parameters<RouteHandler>[1];
type RequestMock = Parameters<RouteHandler>[0];

function makeReply() {
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn(),
    type: vi.fn(),
  };
  return reply as unknown as ReplyMock & typeof reply;
}

function makeRequest(query: Record<string, string>): RequestMock {
  return { query, params: {}, body: undefined } as RequestMock;
}

function findRoute(routes: RouteRegistration[], path: string): RouteRegistration {
  const route = routes.find((r) => r.path === path);
  if (!route) throw new Error(`route not registered: ${path}`);
  return route;
}

describe("street-level-imagery-mapillary setup", () => {
  it("registers the uniform street-level-imagery route surface", () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    expect(routes.map((r) => r.path).sort()).toEqual([
      "/capabilities",
      "/images/:id",
      "/images/:id/links",
      "/nearest",
      "/tiles/:z/:x/:y",
    ]);
  });

  it("registers a street-level-imagery provider", () => {
    const { ctx, registerStreetLevelProvider } = buildCtx();
    setup(ctx);
    expect(registerStreetLevelProvider).toHaveBeenCalledOnce();
  });

  it("advertises MVT coverage even without a token", () => {
    const { ctx, routes } = buildCtx({ accessToken: "" });
    setup(ctx);
    const reply = makeReply();
    void findRoute(routes, "/capabilities").handler(makeRequest({}), reply);
    const sent = reply.send.mock.calls[0]?.[0] as { id: string; coverage: { kind: string } };
    expect(sent.id).toBe("mapillary");
    expect(sent.coverage.kind).toBe("mvt");
  });
});

describe("street-level-imagery-mapillary /nearest", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Mapillary rejects /images bbox queries wider than ~0.0002 deg per side
  // (HTTP 500 "Please reduce the amount of data you're asking for"), so every
  // attempt — including widened retries — must stay under that ceiling.
  const MAPILLARY_MAX_SPAN = 0.0004 + 1e-9;

  it("returns 503 when no access token is configured", async () => {
    const { ctx, routes } = buildCtx({ accessToken: "" });
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/nearest").handler(makeRequest({ lat: "1", lng: "2" }), reply);
    expect(reply.status).toHaveBeenCalledWith(503);
  });

  it("returns 400 for non-numeric coordinates", async () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/nearest").handler(makeRequest({ lat: "abc", lng: "2" }), reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("uses a Mapillary-safe bbox (≤ 0.0004 deg span) on every attempt", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });

    const { ctx, routes } = buildCtx();
    setup(ctx);
    await findRoute(routes, "/nearest").handler(
      makeRequest({ lat: "52.52", lng: "13.41" }),
      makeReply(),
    );

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      const bbox = new URL(String(call[0])).searchParams.get("bbox");
      expect(bbox).toBeTruthy();
      const [west, south, east, north] = (bbox as string).split(",").map(Number);
      expect((east as number) - (west as number)).toBeLessThanOrEqual(MAPILLARY_MAX_SPAN);
      expect((north as number) - (south as number)).toBeLessThanOrEqual(MAPILLARY_MAX_SPAN);
    }
  });

  it("retries with a slightly larger bbox when the first attempt finds no images", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });

    const { ctx, routes } = buildCtx();
    setup(ctx);
    await findRoute(routes, "/nearest").handler(
      makeRequest({ lat: "52.52", lng: "13.41" }),
      makeReply(),
    );

    const spans = fetchMock.mock.calls.map((call) => {
      const bbox = new URL(String(call[0])).searchParams.get("bbox") as string;
      const [west, , east] = bbox.split(",").map(Number);
      return (east as number) - (west as number);
    });
    expect(spans.length).toBeGreaterThan(1);
    expect(spans[spans.length - 1]).toBeGreaterThan(spans[0] as number);
  });

  it("returns 404 when no images are found even after expanding the bbox", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/nearest").handler(makeRequest({ lat: "52.52", lng: "13.41" }), reply);
    expect(reply.status).toHaveBeenCalledWith(404);
  });

  it("returns the nearest image to the requested point", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "far", computed_geometry: { type: "Point", coordinates: [13.42, 52.53] } },
          { id: "near", computed_geometry: { type: "Point", coordinates: [13.41, 52.52] } },
        ],
      }),
    });

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/nearest").handler(makeRequest({ lat: "52.52", lng: "13.41" }), reply);
    const sent = reply.send.mock.calls[0]?.[0] as { id: string };
    expect(sent.id).toBe("near");
  });
});
