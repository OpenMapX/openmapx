import type { IntegrationContext, RouteHandler } from "@openmapx/integration-framework";
import { fakeHttpClient, httpStatus, nth } from "@openmapx/integration-framework/testing";
import { assert, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { setup } from "../index";
import manifest from "../manifest.json";

interface RouteRegistration {
  method: string;
  path: string;
  handler: RouteHandler;
}

/** Answers each Graph API request like fetch, given the URL with its query. */
let activeFetch: (url: string) => Promise<Response> = async () => Response.json({});

const http = fakeHttpClient(async ({ url, options }) => {
  const requestUrl = new URL(url);
  for (const [name, value] of Object.entries(options?.params ?? {})) {
    if (value !== undefined) requestUrl.searchParams.set(name, String(value));
  }
  const response = await activeFetch(requestUrl.toString());
  return response.ok ? response.json() : httpStatus(response.status);
});

function buildCtx(overrides: { accessToken?: string } = {}) {
  const routes: RouteRegistration[] = [];
  const registerStreetLevelProvider = vi.fn();
  const ctx = {
    manifest: structuredClone(manifest),
    config: { accessToken: overrides.accessToken ?? "TOKEN" },
    http,
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
    const { ctx, routes, registerStreetLevelProvider } = buildCtx();
    setup(ctx);
    expect(routes.map((r) => r.path).sort()).toEqual([
      "/capabilities",
      "/images/:id",
      "/images/:id/links",
      "/nearest",
      "/search",
      "/tiles/:z/:x/:y",
    ]);
    expect(registerStreetLevelProvider).toHaveBeenCalledOnce();
  });

  it("advertises MVT coverage even without a token", () => {
    const { ctx, routes } = buildCtx({ accessToken: "" });
    setup(ctx);
    const reply = makeReply();
    void findRoute(routes, "/capabilities").handler(makeRequest({}), reply);
    expect(reply.send.mock.calls[0]?.[0]).toMatchObject({
      id: "mapillary",
      coverage: { kind: "mvt" },
      allowsNavigationUse: false,
    });
  });
});

describe("street-level-imagery-mapillary /nearest", () => {
  let fetchMock: Mock<(url: string) => Promise<Response>>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string) => Promise<Response>>();
    activeFetch = fetchMock;
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
    fetchMock.mockImplementation(async () => Response.json({ data: [] }));

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
    fetchMock.mockImplementation(async () => Response.json({ data: [] }));

    const { ctx, routes } = buildCtx();
    setup(ctx);
    await findRoute(routes, "/nearest").handler(
      makeRequest({ lat: "52.52", lng: "13.41" }),
      makeReply(),
    );

    const spans = fetchMock.mock.calls.map((call) => {
      const bbox = new URL(String(call[0])).searchParams.get("bbox");
      assert.exists(bbox, "the request has no bbox");
      const edges = bbox.split(",").map(Number);
      return nth(edges, 2) - nth(edges, 0);
    });
    expect(spans.length).toBeGreaterThan(1);
    expect(nth(spans, -1)).toBeGreaterThan(nth(spans, 0));
  });

  it("returns 404 when no images are found even after expanding the bbox", async () => {
    fetchMock.mockImplementation(async () => Response.json({ data: [] }));

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/nearest").handler(makeRequest({ lat: "52.52", lng: "13.41" }), reply);
    expect(reply.status).toHaveBeenCalledWith(404);
  });

  it("returns the nearest image to the requested point", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { id: "far", computed_geometry: { type: "Point", coordinates: [13.42, 52.53] } },
          { id: "near", computed_geometry: { type: "Point", coordinates: [13.41, 52.52] } },
        ],
      }),
    );

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/nearest").handler(makeRequest({ lat: "52.52", lng: "13.41" }), reply);
    const sent = reply.send.mock.calls[0]?.[0] as { id: string };
    expect(sent.id).toBe("near");
  });
});

describe("street-level-imagery-mapillary /search", () => {
  let fetchMock: Mock<(url: string) => Promise<Response>>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string) => Promise<Response>>();
    activeFetch = fetchMock;
  });

  it("rejects invalid input with 400", async () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/search").handler(
      makeRequest({ lng: "nope", lat: "51", radius: "400" }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("builds a bbox spanning the whole radius, with the capture filter", async () => {
    fetchMock.mockImplementation(async () => Response.json({ data: [] }));
    const { ctx, routes } = buildCtx();
    setup(ctx);
    await findRoute(routes, "/search").handler(
      makeRequest({ lng: "6.676", lat: "51.179", radius: "400", after: "2018-01-01" }),
      makeReply(),
    );
    const url = new URL(String(nth(fetchMock.mock.calls, 0)[0]));
    expect(url.searchParams.get("start_captured_at")).toBe("2018-01-01T00:00:00.000Z");
    const bbox = (url.searchParams.get("bbox") ?? "").split(",").map(Number);
    expect(bbox).toHaveLength(4);
    const latitudeSpan = nth(bbox, 3) - nth(bbox, 1);
    const longitudeSpan = nth(bbox, 2) - nth(bbox, 0);
    // 400 m either side of the centre: ~0.0072° of latitude and ~0.0115° of
    // longitude at 51° N — a photo 300 m upstream must fall inside.
    expect(latitudeSpan).toBeCloseTo(0.00721, 4);
    expect(longitudeSpan).toBeCloseTo(0.01143, 4);
    // Well under the documented 0.01 deg² ceiling for a bbox query.
    expect(longitudeSpan * latitudeSpan).toBeLessThan(0.01);
    expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(50);
  });

  it("asks for the 1024 px thumbnail and maps it as the image's thumb", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        data: [
          {
            id: "1",
            computed_geometry: { type: "Point", coordinates: [6.68, 51.18] },
            compass_angle: 283,
            captured_at: 1_600_000_000_000,
            thumb_1024_url: "https://scontent.example/1024.jpg",
            thumb_2048_url: "https://scontent.example/2048.jpg",
          },
        ],
      }),
    );
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/search").handler(
      makeRequest({ lng: "6.676", lat: "51.179", radius: "200" }),
      reply,
    );
    const url = new URL(String(nth(fetchMock.mock.calls, 0)[0]));
    expect(url.searchParams.get("fields")).toContain("thumb_1024_url");
    const sent = nth((reply.send as ReturnType<typeof vi.fn>).mock.calls, 0)[0] as {
      assets: { thumb?: string; sd?: string };
    }[];
    expect(nth(sent, 0).assets.thumb).toBe("https://scontent.example/1024.jpg");
    expect(nth(sent, 0).assets.sd).toBe("https://scontent.example/2048.jpg");
  });

  it("filters results by heading in the route and caches for an hour", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        data: [
          {
            id: "1",
            computed_geometry: { type: "Point", coordinates: [6.68, 51.18] },
            compass_angle: 97,
          },
          {
            id: "facing-along",
            computed_geometry: { type: "Point", coordinates: [6.69, 51.18] },
            compass_angle: 283,
          },
        ],
      }),
    );
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/search").handler(
      makeRequest({
        lng: "6.676",
        lat: "51.179",
        radius: "400",
        heading: "283",
        headingTolerance: "30",
      }),
      reply,
    );
    const sent = reply.send.mock.calls[0]?.[0] as { id: string }[];
    expect(sent.map((i) => i.id)).toEqual(["facing-along"]);
    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "public, max-age=3600");
  });

  it("reports an upstream failure as 502", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("upstream down");
    });
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/search").handler(
      makeRequest({ lng: "6.676", lat: "51.179", radius: "400" }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(502);
  });
});

describe("street-level-imagery-mapillary /images/:id", () => {
  it("answers 502 for a rate-limited lookup and keeps the token out of the log", async () => {
    activeFetch = async () => new Response(null, { status: 429 });
    const { ctx, routes } = buildCtx({ accessToken: "SECRET-TOKEN" });
    setup(ctx);
    const reply = makeReply();
    await findRoute(routes, "/images/:id").handler(
      { query: {}, params: { id: "123" }, body: undefined, clientKey: "c", headers: {} },
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(502);
    const logged = JSON.stringify(vi.mocked(ctx.log.warn).mock.calls);
    expect(logged).toContain("429");
    expect(logged).not.toContain("SECRET-TOKEN");
  });
});
