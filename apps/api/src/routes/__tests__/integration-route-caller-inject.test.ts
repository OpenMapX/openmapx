import { httpError, type LoadedIntegration } from "@openmapx/integration-framework";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("../../utils/require-auth.js", () => auth);

import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
  setIntegrationRouteRateLimits,
} from "../../integration-routes.js";
import { uniformErrorHandler } from "../../server-wiring.js";
import { RateLimiter } from "../../utils/rate-limit.js";

let app: FastifyInstance;

beforeEach(async () => {
  auth.requireAuth.mockReset();
  resetIntegrationRoutes();
  registerIntegrationRoute("demo", "GET", "/caller", (req, reply) => {
    reply.send({ clientKey: req.clientKey, userId: req.userId ?? null });
  });
  registerIntegrationRoute(
    "demo",
    "GET",
    "/maybe-signed-in",
    (req, reply) => {
      reply.send({ clientKey: req.clientKey, userId: req.userId ?? null });
    },
    { optionalAuth: true },
  );
  app = Fastify({ logger: false });
  app.setErrorHandler(uniformErrorHandler);
  registerIntegrationRouteDispatcher(
    app,
    new Map([["demo", { enabled: true } as unknown as LoadedIntegration]]),
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
  resetIntegrationRoutes();
  setIntegrationRouteRateLimits(null);
});

async function caller(remoteAddress: string, path = "/caller", headers = {}) {
  const response = await app.inject({
    url: `/api/integrations/demo${path}?ip=203.0.113.99`,
    remoteAddress,
    headers,
  });
  return response.json() as { clientKey: string; userId: string | null };
}

describe("integration route caller identity", () => {
  it("gives every address in one IPv6 /64 the same opaque client key", async () => {
    const first = await caller("2001:db8:1:2::1");
    const sameNetwork = await caller("2001:db8:1:2:abcd::9");
    const otherNetwork = await caller("2001:db8:1:3::1");

    expect(first.clientKey).toMatch(/^[0-9a-f]{32}$/);
    expect(sameNetwork.clientKey).toBe(first.clientKey);
    expect(otherNetwork.clientKey).not.toBe(first.clientKey);
  });

  it("derives the key from the trusted peer, not from anything the caller sends", async () => {
    const plain = await caller("198.51.100.7");
    const mapped = await caller("::ffff:198.51.100.7");
    const forged = await caller("198.51.100.7", "/caller", { "x-forwarded-for": "192.0.2.1" });

    expect(mapped.clientKey).toBe(plain.clientKey);
    expect(forged.clientKey).toBe(plain.clientKey);
    expect(plain.clientKey).not.toContain("198.51.100.7");
  });

  it("lets an anonymous caller through an optional-auth route without a session lookup", async () => {
    const anonymous = await caller("198.51.100.7", "/maybe-signed-in");

    expect(anonymous.userId).toBeNull();
    expect(auth.requireAuth).not.toHaveBeenCalled();
  });

  it("passes the user of a valid session, and ignores an invalid one", async () => {
    auth.requireAuth.mockResolvedValueOnce("user-1");
    const signedIn = await caller("198.51.100.7", "/maybe-signed-in", { cookie: "session=ok" });
    auth.requireAuth.mockRejectedValueOnce(httpError(401, "Authentication required"));
    const stale = await caller("198.51.100.7", "/maybe-signed-in", { cookie: "session=stale" });

    expect(signedIn.userId).toBe("user-1");
    expect(stale.userId).toBeNull();
  });

  it("charges a path that matches no integration route to the unmatched bucket", async () => {
    const unmatched = new RateLimiter({ max: 2, windowMs: 60_000 });
    const routeTier = vi.fn(async () => {});
    setIntegrationRouteRateLimits({
      public: routeTier,
      expensive: routeTier,
      typeahead: routeTier,
      routing: routeTier,
      tile: routeTier,
      unmatched: unmatched.preHandler(),
    });
    const statuses: number[] = [];
    for (const url of [
      "/api/integrations/demo/missing",
      "/api/integrations/unknown/anything",
      "/api/integrations/demo/missing",
    ]) {
      statuses.push((await app.inject({ url, remoteAddress: "198.51.100.7" })).statusCode);
    }

    expect(statuses).toEqual([404, 404, 429]);
    expect(routeTier).not.toHaveBeenCalled();
    unmatched.destroy();
  });
});
