import type { RouteHandler } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";

interface MockReply {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status: (code: number) => MockReply;
  header: (key: string, value: string) => MockReply;
  send: (body?: unknown) => MockReply;
}

function mockReply(): MockReply {
  const reply: MockReply = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      reply.statusCode = code;
      return reply;
    },
    header(key, value) {
      reply.headers[key] = value;
      return reply;
    },
    send(body) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

// Typed as RouteHandler (not a hand-rolled shape) so that if the real
// dispatcher's req contract (apps/api/src/integration-routes.ts) ever drops
// or renames a field — headers included — the call sites below stop
// compiling instead of silently testing a shape production no longer sends.
function register(): RouteHandler {
  let handler: RouteHandler | undefined;
  const ctx = {
    registerRoute: (_method: string, _path: string, h: RouteHandler) => {
      handler = h;
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  setup(ctx as never);
  if (!handler) throw new Error("route was not registered");
  return handler;
}

// The real dispatcher always sends query/params/body/headers, even when
// empty — mirror that shape rather than passing only the field this handler
// happens to read.
function baseReq(headers: Record<string, string | string[] | undefined> = {}) {
  return { query: {}, params: {}, body: undefined, headers };
}

describe("overlay-sun-time /timezones", () => {
  it("serves the boundary collection with a strong ETag", async () => {
    const handler = register();
    const reply = mockReply();
    await handler(baseReq(), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.headers.ETag).toMatch(/^"[a-f0-9]{16}"$/);
    expect(reply.headers["Cache-Control"]).toContain("max-age=604800");
    // The vendored asset dissolves timezones that share identical current
    // UTC-offset/DST rules into one polygon (see timezones.meta.json), so
    // the real collection has 64 features, not the "hundreds" a naive
    // one-polygon-per-IANA-zone assumption would suggest.
    expect((reply.body as { features: unknown[] }).features.length).toBeGreaterThan(55);
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const handler = register();
    const first = mockReply();
    await handler(baseReq(), first);

    // Node lowercases incoming header names, and a real client echoes back
    // exactly the (already-quoted) ETag value it received — the dispatcher
    // test in apps/api/src/integration-host.test.ts proves that round-trip
    // for real over HTTP; this only re-proves the handler's own comparison.
    const second = mockReply();
    await handler(baseReq({ "if-none-match": first.headers.ETag }), second);

    expect(second.statusCode).toBe(304);
    expect(second.body).toBeUndefined();
  });
});
