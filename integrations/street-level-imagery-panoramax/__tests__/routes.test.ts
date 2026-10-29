// IntegrationContext and RouteHandler live in integration-framework, NOT core.

import type { StreetLevelImage } from "@openmapx/core";
import type { IntegrationContext, StreetLevelProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index";
import manifest from "../manifest.json";

function buildCtx() {
  const ctx = createMockIntegrationContext({
    manifest: structuredClone(manifest) as IntegrationContext["manifest"],
    config: { instanceUrl: "https://example.test/api" },
  });
  const registerStreetLevelProvider = vi.spyOn(ctx, "registerStreetLevelProvider");
  return { ctx, routes: ctx.registered.routes, registerStreetLevelProvider };
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

describe("captured Panoramax image receipts", () => {
  afterEach(() => vi.unstubAllGlobals());
  const item = {
    id: "captured-file",
    geometry: { type: "Point", coordinates: [2.35, 48.85] },
    providers: [{ name: "Per-file photographer", roles: ["producer"] }],
    properties: { license: "CC-BY-SA-4.0" },
    assets: { sd: { href: "https://image.test/file.jpg" } },
    links: [{ rel: "license", href: "https://creativecommons.org/licenses/by-sa/4.0/" }],
  };
  function assertFile(image: StreetLevelImage) {
    expect(image.contributors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "panoramax",
          name: "Panoramax",
          url: "https://panoramax.xyz/#focus=pic&pic=captured-file",
          publisher: { name: "Per-file photographer" },
          licensing: expect.objectContaining({
            bindings: [
              expect.objectContaining({
                scope: "imagery",
                license: {
                  kind: "spdx",
                  expression: "CC-BY-SA-4.0",
                  url: "https://creativecommons.org/licenses/by-sa/4.0/",
                },
              }),
            ],
          }),
        }),
      ]),
    );
    expect(JSON.stringify(image.contributors)).not.toContain("etalab");
  }
  it.each(["/search", "/images/:id", "/nearest"])(
    "sends captured per-file creator, page and licence before %s caller caching",
    async (path) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(path === "/images/:id" ? item : { features: [item] })),
      );
      const { ctx, routes } = buildCtx();
      setup(ctx);
      const reply = makeReply();
      await routes
        .find((route) => route.path === path)
        ?.handler(
          { params: { id: item.id }, query: { lng: "2.35", lat: "48.85", radius: "400" } } as never,
          reply as never,
        );
      expect(reply.status).not.toHaveBeenCalled();
      const sent = reply.send.mock.calls[0]?.[0];
      assertFile(path === "/search" ? sent[0] : sent);
    },
  );
  it("registers the captured provider and snapshots source metadata before deferred acquisition", async () => {
    let complete!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const { ctx, registerStreetLevelProvider } = buildCtx();
    setup(ctx);
    const provider = registerStreetLevelProvider.mock.calls[0]?.[0] as StreetLevelProvider;
    const pending = provider.getImage(item.id);
    const source = ctx.manifest.dataSources?.[0];
    if (!source) throw new Error("Expected declared Panoramax metadata");
    source.name = "Renamed after acquisition";
    complete(Response.json(item));
    const image = await pending;
    expect(image).not.toBeNull();
    if (image) assertFile(image);
  });
});
