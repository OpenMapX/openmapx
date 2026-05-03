import type { IntegrationContext } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { setup } from "../index";

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

function makeCtx(): IntegrationContext & { routes: Map<string, RouteHandler> } {
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

describe("GET /preset-suggest", () => {
  it("returns matches for a German query", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/preset-suggest");
    const reply = makeReply();
    if (!handler) throw new Error("handler not registered");
    await handler({ query: { q: "eisdiele", lang: "de" } }, reply);

    const payload = reply.payload as { matches: Array<{ id: string }> };
    expect(payload.matches[0].id).toBe("amenity/ice_cream");
  });

  it("returns empty matches for queries shorter than 2 chars", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/preset-suggest");
    const reply = makeReply();
    if (!handler) throw new Error("handler not registered");
    await handler({ query: { q: "e", lang: "de" } }, reply);

    expect(reply.payload).toEqual({ matches: [] });
  });

  it("returns empty matches when q is missing", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/preset-suggest");
    const reply = makeReply();
    if (!handler) throw new Error("handler not registered");
    await handler({ query: {} }, reply);

    expect(reply.payload).toEqual({ matches: [] });
  });

  it("respects an explicit limit", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/preset-suggest");
    const reply = makeReply();
    if (!handler) throw new Error("handler not registered");
    await handler({ query: { q: "shop", lang: "en", limit: "2" } }, reply);

    const payload = reply.payload as { matches: unknown[] };
    expect(payload.matches.length).toBeLessThanOrEqual(2);
  });

  it("falls back to the default cap when limit is non-numeric (NaN protection)", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/preset-suggest");
    const reply = makeReply();
    if (!handler) throw new Error("handler not registered");
    await handler({ query: { q: "shop", lang: "en", limit: "not-a-number" } }, reply);

    const payload = reply.payload as { matches: unknown[] };
    // Default cap is 8 matches; before the fix NaN bypassed the cap entirely
    // and the route returned every match (potentially hundreds).
    expect(payload.matches.length).toBeLessThanOrEqual(8);
  });
});
