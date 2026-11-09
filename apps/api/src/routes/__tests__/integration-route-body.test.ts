import { Readable } from "node:stream";
import { httpError, type LoadedIntegration } from "@openmapx/integration-framework";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("../../utils/require-auth.js", () => auth);

import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "../../integration-routes.js";
import { uniformErrorHandler } from "../../server-wiring.js";

const MIB = 1024 * 1024;
const handled: string[] = [];
let app: FastifyInstance;

function register(path: string, options?: Parameters<typeof registerIntegrationRoute>[4]) {
  registerIntegrationRoute(
    "demo",
    "POST",
    path,
    (req, reply) => {
      handled.push(path);
      reply.send({ userId: req.userId ?? null, bytes: JSON.stringify(req.body).length });
    },
    options,
  );
}

async function build() {
  app = Fastify({ logger: false });
  app.setErrorHandler(uniformErrorHandler);
  registerIntegrationRouteDispatcher(
    app,
    new Map([["demo", { enabled: true } as unknown as LoadedIntegration]]),
  );
  await app.ready();
}

const post = (path: string, payload: string) =>
  app.inject({
    method: "POST",
    url: `/api/integrations/demo${path}`,
    payload,
    headers: { "content-type": "application/json" },
  });
const padded = (size: number) => JSON.stringify({ padding: "x".repeat(size) });

beforeEach(async () => {
  handled.length = 0;
  auth.requireAuth.mockReset();
  resetIntegrationRoutes();
  register("/plain");
  register("/larger", { bodyLimit: 2 * MIB });
  register("/unbounded", { bodyLimit: 100 * MIB });
  register("/private", { requireAuth: true });
  await build();
});

afterEach(async () => {
  await app.close();
  resetIntegrationRoutes();
});

describe("integration route request bodies", () => {
  it("accepts a body up to 1 MiB by default and answers 413 above it", async () => {
    expect((await post("/plain", padded(MIB - 1024))).statusCode).toBe(200);
    expect((await post("/plain", padded(MIB + 1024))).statusCode).toBe(413);
    expect(handled).toEqual(["/plain"]);
  });

  it("holds a route to the limit it declares", async () => {
    expect((await post("/larger", padded(MIB + 1024))).statusCode).toBe(200);
    expect((await post("/larger", padded(2 * MIB + 1024))).statusCode).toBe(413);
  });

  it("never allows more than 8 MiB, whatever a route declares", async () => {
    expect((await post("/unbounded", padded(7 * MIB))).statusCode).toBe(200);
    expect((await post("/unbounded", padded(9 * MIB))).statusCode).toBe(413);
  });

  it("answers 401 to a route that requires a session before parsing its body", async () => {
    auth.requireAuth.mockRejectedValue(httpError(401, "Authentication required"));

    const response = await post("/private", "{");

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required" });
    expect(handled).toEqual([]);
  });

  it("parses the body and hands the user to a route once the session is valid", async () => {
    auth.requireAuth.mockResolvedValue("user-1");

    expect((await post("/private", "{")).statusCode).toBe(400);
    const response = await post("/private", JSON.stringify({ a: 1 }));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: "user-1", bytes: 7 });
  });

  it("answers 404 without reading a body for a route that does not exist", async () => {
    expect((await post("/missing", padded(100))).statusCode).toBe(404);
    expect(handled).toEqual([]);
  });

  it("holds a body streamed without a declared length to the limit as it arrives", async () => {
    const chunk = Buffer.alloc(256 * 1024, "x");
    const stream = Readable.from(
      (function* () {
        yield Buffer.from('{"padding":"');
        for (let sent = 0; sent < 3 * MIB; sent += chunk.length) yield chunk;
        yield Buffer.from('"}');
      })(),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/integrations/demo/plain",
      payload: stream,
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "Request body too large" });
    expect(handled).toEqual([]);
  });
});
