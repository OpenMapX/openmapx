import type { RouteHandler } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";

interface MockReply {
  statusCode: number;
  headers: Record<string, string>;
  contentType: string | undefined;
  body: unknown;
  status: (code: number) => MockReply;
  header: (key: string, value: string) => MockReply;
  type: (contentType: string) => MockReply;
  send: (body?: unknown) => MockReply;
}

function mockReply(): MockReply {
  const reply: MockReply = {
    statusCode: 200,
    headers: {},
    contentType: undefined,
    body: undefined,
    status(code) {
      reply.statusCode = code;
      return reply;
    },
    header(key, value) {
      reply.headers[key] = value;
      return reply;
    },
    type(contentType) {
      reply.contentType = contentType;
      return reply;
    },
    send(body) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

// Typed as RouteHandler (not a hand-rolled shape) so the object literals
// below mirror the real dispatcher's req exactly — useful signal while
// editing. It is not a compile-time guard on its own: integration test
// files are excluded from apps/api/tsconfig.integrations.json, so this
// file is never part of the build-time check. The guard that actually
// enforces the contract is the dispatcher-level test in
// apps/api/src/integration-host.test.ts, which runs the real,
// unmocked dispatcher over real HTTP.
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
    expect(reply.contentType).toBe("application/json");

    // The body is served as the raw file text, not a parsed object, so
    // Fastify never re-stringifies it per request. Asserting `typeof` here
    // pins that contract; parsing it below both proves it's well-formed JSON
    // (a truncated or corrupted body would throw) and re-derives the feature
    // count from the actual bytes on the wire, not a value the handler
    // happens to hold in memory.
    expect(typeof reply.body).toBe("string");
    const raw = reply.body as string;
    expect(raw.length).toBeGreaterThan(1_000_000);
    const parsed = JSON.parse(raw) as { features: unknown[] };
    // The vendored asset dissolves timezones that share identical current
    // UTC-offset/DST rules into one polygon (see timezones.meta.json), so
    // the real collection has 64 features, not the "hundreds" a naive
    // one-polygon-per-IANA-zone assumption would suggest.
    expect(parsed.features.length).toBeGreaterThan(55);
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
