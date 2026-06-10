import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins the two response shapes the codebase relies on to coexist with the async
 * data-use-policy preSerialization hook without the double-send crash:
 *
 *   1. throw an error with `statusCode` (how requireAuth/requireAdmin now abort)
 *   2. send via a shim, then `return reply` (how the integration dispatcher ends)
 *
 * Both must deliver the correct status + body and never crash. The pattern that
 * does NOT appear here — `reply.send(); return undefined;` — is the one that
 * crashes under an async hook; the structural fixes remove it, and the
 * server.ts uncaughtException guard is the backstop if one ever returns.
 *
 * Runs against a real listening server because the raw-socket double write does
 * not surface through `inject`.
 */
describe("double-send fix: throw + return-reply under an async preSerialization hook", () => {
  let app: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function build() {
    app = Fastify({ logger: false });
    // The real hook awaits (DB-backed policy lookup). Mirror that here.
    app.addHook(
      "preSerialization",
      async (_req: FastifyRequest, _reply: FastifyReply, payload: unknown) => {
        await Promise.resolve();
        return payload;
      },
    );
    // requireAuth/requireAdmin throw with a statusCode; Fastify's default error
    // handler honors it.
    app.get("/throws", async () => {
      throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
    });
    // The dispatcher shape: send via a shim, then hand the reply back.
    app.get("/shim", async (_request: FastifyRequest, reply: FastifyReply) => {
      const shim = { send: (d: unknown) => reply.send(d) };
      await Promise.resolve();
      shim.send({ ok: true });
      return reply;
    });
    return app;
  }

  it("a thrown 401 yields status 401 + a body, no crash", async () => {
    const a = build();
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onError);
    try {
      const address = await a.listen({ port: 0, host: "127.0.0.1" });
      const res = await fetch(`${address}/throws`);
      const body = await res.text();
      await new Promise((r) => setTimeout(r, 100));
      expect(res.status).toBe(401);
      expect(JSON.parse(body).message).toBe("Authentication required");
      expect(errors).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onError);
    }
  });

  it("send-via-shim then return reply yields the body intact, no crash", async () => {
    const a = build();
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onError);
    try {
      const address = await a.listen({ port: 0, host: "127.0.0.1" });
      const res = await fetch(`${address}/shim`);
      const body = await res.text();
      await new Promise((r) => setTimeout(r, 100));
      expect(res.status).toBe(200);
      expect(JSON.parse(body)).toEqual({ ok: true });
      expect(errors).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onError);
    }
  });
});
