import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";

type Handler = (req: unknown, reply: MockReply) => Promise<void> | void;

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

function register(): Handler {
  let handler: Handler | undefined;
  const ctx = {
    registerRoute: (_method: string, _path: string, h: Handler) => {
      handler = h;
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  setup(ctx as never);
  if (!handler) throw new Error("route was not registered");
  return handler;
}

describe("overlay-sun-time /timezones", () => {
  it("serves the boundary collection with a strong ETag", async () => {
    const handler = register();
    const reply = mockReply();
    await handler({ headers: {} }, reply);

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
    await handler({ headers: {} }, first);

    const second = mockReply();
    await handler({ headers: { "if-none-match": first.headers.ETag } }, second);

    expect(second.statusCode).toBe(304);
    expect(second.body).toBeUndefined();
  });
});
