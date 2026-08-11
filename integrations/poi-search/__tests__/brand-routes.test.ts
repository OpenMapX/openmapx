import { getBrandByQid, suggestBrands } from "@openmapx/brands";
import { brandToFilter, validateOverpassFilter } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";

type RouteHandler = (
  req: { query: Record<string, string | undefined>; params: Record<string, string | undefined> },
  reply: FakeReply,
) => Promise<void> | void;

interface FakeReply {
  header: (k: string, v: string) => FakeReply;
  send: (p: unknown) => FakeReply;
  status: (n: number) => FakeReply;
  payload: unknown;
  statusCode: number;
  headers: Record<string, string>;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    payload: undefined,
    statusCode: 200,
    headers: {},
    header(k, v) {
      reply.headers[k] = v;
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
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    routes,
  } as unknown as IntegrationContext & { routes: Map<string, RouteHandler> };
  return ctx;
}

describe("GET /brand-suggest route", () => {
  it("returns empty matches for a query shorter than 2 chars", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/brand-suggest");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();

    await handler({ query: { q: "a" }, params: {} }, reply);

    expect(reply.payload).toEqual({ matches: [] });
    expect(reply.headers["Cache-Control"]).toBe("public, max-age=60");
  });

  it("returns empty matches when q is missing", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/brand-suggest");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();

    await handler({ query: {}, params: {} }, reply);

    expect(reply.payload).toEqual({ matches: [] });
  });

  it("returns matches for a known chain and sets the long-lived cache header", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/brand-suggest");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();

    await handler({ query: { q: "aldi", country: "de" }, params: {} }, reply);

    const payload = reply.payload as { matches: Array<{ qid: string }> };
    expect(payload.matches.length).toBeGreaterThan(0);
    expect(reply.headers["Cache-Control"]).toBe("public, max-age=3600");
  });

  it("clamps an oversized limit query param to 20", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/brand-suggest");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();

    await handler({ query: { q: "a", limit: "500" }, params: {} }, reply);

    const payload = reply.payload as { matches: unknown[] };
    expect(payload.matches.length).toBeLessThanOrEqual(20);
  });

  it("ignores a malformed country code rather than rejecting the request", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/brand-suggest");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();

    await handler({ query: { q: "starbucks", country: "not-a-country" }, params: {} }, reply);

    expect(reply.statusCode).toBe(200);
    const payload = reply.payload as { matches: unknown[] };
    expect(payload.matches.length).toBeGreaterThan(0);
  });
});

describe("GET /brand/:qid route", () => {
  it("400s for a malformed QID", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/brand/:qid");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();

    await handler({ query: {}, params: { qid: "not-a-qid" } }, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: "Invalid Wikidata QID" });
  });

  it("400s when the qid param is missing", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/brand/:qid");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();

    await handler({ query: {}, params: {} }, reply);

    expect(reply.statusCode).toBe(400);
  });

  it("404s for a well-formed but unknown QID", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const handler = ctx.routes.get("/brand/:qid");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();

    await handler({ query: {}, params: { qid: "Q00000000" } }, reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({ error: "Unknown brand: Q00000000" });
  });

  it("200s with the brand entry and the day-long cache header for a known QID", async () => {
    const ctx = makeCtx();
    setup(ctx);
    const suggestHandler = ctx.routes.get("/brand-suggest");
    if (!suggestHandler) throw new Error("handler not registered");
    const suggestReply = makeReply();
    await suggestHandler({ query: { q: "starbucks", country: "us" }, params: {} }, suggestReply);
    const qid = (suggestReply.payload as { matches: Array<{ qid: string }> }).matches[0].qid;

    const handler = ctx.routes.get("/brand/:qid");
    if (!handler) throw new Error("handler not registered");
    const reply = makeReply();
    await handler({ query: {}, params: { qid } }, reply);

    expect(reply.statusCode).toBe(200);
    expect((reply.payload as { qid: string }).qid).toBe(qid);
    expect(reply.headers["Cache-Control"]).toBe("public, max-age=86400");
  });
});

describe("brand catalog behind the routes", () => {
  it("suggests a well-known chain by exact name", () => {
    const matches = suggestBrands("starbucks", "us", 8);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name.toLowerCase()).toContain("starbucks");
    expect(matches[0].qid).toMatch(/^Q\d+$/);
  });

  it("returns nothing for a query shorter than the route's floor", () => {
    expect(suggestBrands("", undefined, 8)).toEqual([]);
  });

  it("clamps the limit to 20", () => {
    expect(suggestBrands("a", undefined, 500).length).toBeLessThanOrEqual(20);
  });

  it("resolves a suggested brand by QID", () => {
    const qid = suggestBrands("starbucks", "us", 1)[0].qid;
    const entry = getBrandByQid(qid);
    expect(entry?.qid).toBe(qid);
    expect(entry?.matchNames.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown QID", () => {
    expect(getBrandByQid("Q00000000")).toBeUndefined();
  });

  it("produces suggestions whose compiled filters all pass validation", () => {
    for (const match of suggestBrands("aldi", "de", 5)) {
      const result = validateOverpassFilter(brandToFilter(match));
      expect(result.ok).toBe(true);
    }
  });
});
