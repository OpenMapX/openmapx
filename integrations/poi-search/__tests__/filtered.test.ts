import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";
import { createPoiSearchOrchestrator } from "../orchestrator";
import type { PoiSearchProvider } from "../types";

const BBOX = { south: 48.85, west: 2.33, north: 48.87, east: 2.37 };

function makeCtx(provider: PoiSearchProvider) {
  return {
    getIntegrationsByDomain: () => [{ providers: new Map([["poi-search", [provider]]]) }],
  } as unknown as Parameters<typeof createPoiSearchOrchestrator>[0];
}

type RouteHandler = (
  req: { query: Record<string, string | undefined> },
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

function makeRouteCtx(): IntegrationContext & { routes: Map<string, RouteHandler> } {
  const routes = new Map<string, RouteHandler>();
  const ctx = {
    registerRoute(_method: string, path: string, handler: RouteHandler) {
      routes.set(path, handler);
    },
    getIntegrationsByDomain: () => [],
    getRequiredService: () => ({}),
    cache: {
      async withCache<T>(_k: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    },
    routes,
  } as unknown as IntegrationContext & { routes: Map<string, RouteHandler> };
  return ctx;
}

const VALID_BBOX_QUERY = { south: "48.85", west: "2.33", north: "48.87", east: "2.37" };

describe("GET /filtered tag validation", () => {
  it("400s when a tag value is not a string", async () => {
    const ctx = makeRouteCtx();
    setup(ctx);
    const handler = ctx.routes.get("/filtered");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();
    await handler(
      {
        query: {
          category: "cafes",
          tags: JSON.stringify({ wheelchair: 5 }),
          ...VALID_BBOX_QUERY,
        },
      },
      reply,
    );
    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: "Invalid tags: values must be strings" });
  });

  it("400s when tags is a JSON array", async () => {
    const ctx = makeRouteCtx();
    setup(ctx);
    const handler = ctx.routes.get("/filtered");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();
    await handler(
      { query: { category: "cafes", tags: JSON.stringify(["a"]), ...VALID_BBOX_QUERY } },
      reply,
    );
    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: "Invalid tags: must be a JSON object" });
  });
});

describe("orchestrator searchFiltered", () => {
  it("dispatches to provider.searchFiltered and returns results", async () => {
    const provider: PoiSearchProvider = {
      id: "fake-overpass",
      categories: ["cafes"],
      search: vi.fn(),
      searchFiltered: vi.fn(async () => [{ id: "1", name: "A", coordinates: [2.35, 48.86] }]),
    };
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const result = await orch.searchFiltered("cafes", { outdoor_seating: "yes" }, BBOX, {});
    expect(provider.searchFiltered).toHaveBeenCalledWith(
      "cafes",
      { outdoor_seating: "yes" },
      BBOX,
      expect.objectContaining({ lang: undefined }),
    );
    expect(result.results).toHaveLength(1);
  });

  it("rejects with statusCode 400 when no provider covers the category", async () => {
    const provider: PoiSearchProvider = {
      id: "fake-overpass",
      categories: ["bars"],
      search: vi.fn(),
      searchFiltered: vi.fn(),
    };
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    await expect(orch.searchFiltered("cafes", {}, BBOX, {})).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
