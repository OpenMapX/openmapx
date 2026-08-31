import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

type Handler = (
  req: { params: Record<string, string>; query: Record<string, string>; signal?: AbortSignal },
  reply: Reply,
) => Promise<void> | void;

class Reply {
  statusCode = 200;
  headers: Record<string, string> = {};
  contentType: string | undefined;
  body: unknown;
  sent = false;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  header(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  type(value: string) {
    this.contentType = value;
    return this;
  }
  send(payload?: unknown) {
    this.body = payload;
    this.sent = true;
  }
}

const mockFetch = vi.fn();

function tileRoute(ctx: ReturnType<typeof createMockIntegrationContext>): {
  handler: Handler;
  options: { rateLimitTier?: string } | undefined;
} {
  const route = ctx.registered.routes.find((r) => r.path === "/tiles/:network/:layout/:z/:x/:y");
  if (!route) throw new Error("tile route not registered");
  return { handler: route.handler as unknown as Handler, options: route.options };
}

function mvtResponse(bytes = 64): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/octet-stream", "content-length": String(bytes) },
  });
}

describe("overlay-schematic-transit tile proxy", () => {
  let ctx: ReturnType<typeof createMockIntegrationContext>;

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    ctx = createMockIntegrationContext();
    setup(ctx);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the tile route on the tile rate-limit tier", () => {
    const { options } = tileRoute(ctx);
    expect(options?.rateLimitTier).toBe("tile");
  });

  it("proxies a valid tile with week-long caching headers", async () => {
    mockFetch.mockResolvedValue(mvtResponse());
    const { handler } = tileRoute(ctx);
    const reply = new Reply();
    await handler(
      {
        params: { network: "subway-lightrail", layout: "octi", z: "11", x: "1100", y: "671" },
        query: {},
      },
      reply,
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toBe("https://loom.cs.uni-freiburg.de/tiles/subway-lightrail/octi/11/1100/671.mvt");
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["cache-control"]).toBe("public, max-age=604800, s-maxage=604800");
    expect(reply.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(reply.contentType).toBe("application/octet-stream");
    expect(reply.sent).toBe(true);
  });

  it.each([
    { name: "unknown network", params: { network: "bus", layout: "geo", z: "3", x: "1", y: "1" } },
    {
      name: "unsupported geo-octi layout",
      params: { network: "tram", layout: "geo-octi", z: "3", x: "1", y: "1" },
    },
    {
      name: "path traversal in z",
      params: { network: "tram", layout: "geo", z: "..", x: "1", y: "1" },
    },
    { name: "non-numeric x", params: { network: "tram", layout: "geo", z: "3", x: "a", y: "1" } },
    { name: "three-digit z", params: { network: "tram", layout: "geo", z: "123", x: "1", y: "1" } },
  ])("rejects $name with 400 and no upstream fetch", async ({ params }) => {
    const { handler } = tileRoute(ctx);
    const reply = new Reply();
    await handler({ params, query: {} }, reply);
    expect(reply.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps upstream 404 (empty area) to a cacheable empty 204", async () => {
    mockFetch.mockResolvedValue(new Response("<html>not found</html>", { status: 404 }));
    const { handler } = tileRoute(ctx);
    const reply = new Reply();
    await handler(
      { params: { network: "tram", layout: "geo", z: "11", x: "300", y: "700" }, query: {} },
      reply,
    );
    expect(reply.statusCode).toBe(204);
    expect(reply.headers["cache-control"]).toBe("public, max-age=86400");
    expect(reply.body).toBeUndefined();
  });

  it("passes through an upstream 500", async () => {
    mockFetch.mockResolvedValue(new Response("boom", { status: 500 }));
    const { handler } = tileRoute(ctx);
    const reply = new Reply();
    await handler(
      { params: { network: "rail", layout: "geo", z: "3", x: "1", y: "1" }, query: {} },
      reply,
    );
    expect(reply.statusCode).toBe(500);
  });

  it("answers 502 when the upstream fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("connect timeout"));
    const { handler } = tileRoute(ctx);
    const reply = new Reply();
    await handler(
      { params: { network: "rail", layout: "geo", z: "3", x: "1", y: "1" }, query: {} },
      reply,
    );
    expect(reply.statusCode).toBe(502);
  });

  it("respects a configured tileBaseUrl override", async () => {
    mockFetch.mockResolvedValue(mvtResponse());
    const custom = createMockIntegrationContext({
      config: { tileBaseUrl: "https://loom.example.org/tiles/" },
    });
    setup(custom);
    const { handler } = tileRoute(custom);
    const reply = new Reply();
    await handler(
      { params: { network: "rail", layout: "geo", z: "3", x: "1", y: "1" }, query: {} },
      reply,
    );
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "https://loom.example.org/tiles/rail/geo/3/1/1.mvt",
    );
  });
});
