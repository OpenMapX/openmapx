// IntegrationContext and RouteHandler live in integration-framework, NOT core.
import type { IntegrationContext, RouteHandler } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index";

interface RouteRegistration {
  method: string;
  path: string;
  handler: RouteHandler;
}

function buildCtx() {
  const routes: RouteRegistration[] = [];
  const registerStreetLevelProvider = vi.fn();
  const ctx = {
    config: { instanceUrl: "https://example.test/api" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerRoute: (method: string, path: string, handler: RouteHandler) => {
      routes.push({ method, path, handler });
    },
    registerStreetLevelProvider,
  } as unknown as IntegrationContext;
  return { ctx, routes, registerStreetLevelProvider };
}

function makeReply() {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn(),
    type: vi.fn(),
  };
}

describe("street-level-imagery-panoramax setup", () => {
  it("registers the uniform street-level-imagery route surface", () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    expect(routes.map((r) => r.path).sort()).toEqual([
      "/capabilities",
      "/images/:id",
      "/images/:id/links",
      "/nearest",
      "/search",
      "/tiles/:z/:x/:y",
    ]);
  });

  it("registers a street-level-imagery provider", () => {
    const { ctx, registerStreetLevelProvider } = buildCtx();
    setup(ctx);
    expect(registerStreetLevelProvider).toHaveBeenCalledOnce();
  });

  it("serves capabilities describing an MVT coverage layer", async () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/capabilities")
      ?.handler({ params: {}, query: {} } as never, reply as never);

    const sent = reply.send.mock.calls[0]?.[0] as { id: string; coverage: { kind: string } };
    expect(sent.id).toBe("panoramax");
    expect(sent.coverage.kind).toBe("mvt");
  });

  it("rejects non-numeric tile coordinates", async () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/tiles/:z/:x/:y")
      ?.handler({ params: { z: "1; DROP", x: "1", y: "1" }, query: {} } as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("rejects invalid nearest coordinates", async () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/nearest")
      ?.handler({ params: {}, query: { lat: "nope", lng: "2" } } as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(400);
  });
});

describe("upstream failure handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an upstream failure as 502, not as missing imagery", async () => {
    // A timeout or rate-limit answered as 404 is indistinguishable from
    // "there is genuinely nothing here", which is a lie the caller acts on.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("upstream timeout");
      }),
    );

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/nearest")
      ?.handler({ params: {}, query: { lat: "48.85", lng: "2.35" } } as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(502);
  });

  it("rejects a non-vector tile response with a normalized 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not a tile", { headers: { "Content-Type": "text/html" } })),
    );

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/tiles/:z/:x/:y")
      ?.handler({ params: { z: "12", x: "1", y: "2" }, query: {} } as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(502);
    expect(reply.send).toHaveBeenCalledWith({ message: "Panoramax tile unavailable" });
  });

  it("still reports genuine absence as 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ type: "FeatureCollection", features: [] })),
    );

    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/nearest")
      ?.handler({ params: {}, query: { lat: "48.85", lng: "2.35" } } as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(404);
  });
});

describe("GET /search", () => {
  it("registers the search route in the sorted path list", () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    expect(routes.map((r) => r.path).sort()).toEqual([
      "/capabilities",
      "/images/:id",
      "/images/:id/links",
      "/nearest",
      "/search",
      "/tiles/:z/:x/:y",
    ]);
  });

  it("rejects an invalid lng with 400", async () => {
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/search")
      ?.handler(
        { params: {}, query: { lng: "nope", lat: "51", radius: "400" } } as never,
        reply as never,
      );
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("filters results by heading in the route and caches for an hour", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          type: "FeatureCollection",
          features: [
            {
              id: "facing-away",
              type: "Feature",
              geometry: { type: "Point", coordinates: [2.35, 48.85] },
              properties: { "view:azimuth": 97 },
            },
            {
              id: "facing-along",
              type: "Feature",
              geometry: { type: "Point", coordinates: [2.36, 48.86] },
              properties: { "view:azimuth": 283 },
            },
          ],
        }),
      ),
    );
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/search")
      ?.handler(
        {
          params: {},
          query: {
            lng: "2.35",
            lat: "48.85",
            radius: "400",
            heading: "283",
            headingTolerance: "30",
          },
        } as never,
        reply as never,
      );
    expect(reply.status).not.toHaveBeenCalled();
    const sent = reply.send.mock.calls[0]?.[0] as { id: string }[];
    expect(sent.map((i) => i.id)).toEqual(["facing-along"]);
    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "public, max-age=3600");
    vi.unstubAllGlobals();
  });

  it("reports an upstream failure as 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("upstream down");
      }),
    );
    const { ctx, routes } = buildCtx();
    setup(ctx);
    const reply = makeReply();
    await routes
      .find((r) => r.path === "/search")
      ?.handler(
        { params: {}, query: { lng: "2.35", lat: "48.85", radius: "400" } } as never,
        reply as never,
      );
    expect(reply.status).toHaveBeenCalledWith(502);
    vi.unstubAllGlobals();
  });
});
